const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { initializeApp } = require('firebase-admin/app');

initializeApp();

const db = getFirestore();

const DELIVERY_MATRIX = {
  Nyali: { Nyali: 75, 'Mombasa CBD': 200, Tudor: 250, Bamburi: 150, Mtwapa: 300 },
  'Mombasa CBD': { 'Mombasa CBD': 75, Nyali: 200, Tudor: 100, Bamburi: 300, Mtwapa: 400 },
  Tudor: { Tudor: 75, 'Mombasa CBD': 100, Nyali: 250, Bamburi: 350, Mtwapa: 450 }
};
const DELIVERY_AREAS = new Set(['Nyali', 'Mombasa CBD', 'Tudor', 'Bamburi', 'Mtwapa']);

function deliveryFee(pickupZone, deliveryArea) {
  return DELIVERY_MATRIX[pickupZone]?.[deliveryArea] ?? 200;
}

function text(value, maxLength = 120) {
  return String(value ?? '').trim().slice(0, maxLength);
}

exports.createCheckout = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth?.token?.email) {
    throw new HttpsError('unauthenticated', 'Please sign in before checking out.');
  }

  const data = request.data || {};
  const deliveryArea = text(data.deliveryArea);
  const phone = text(data.phone, 20);
  const paymentType = data.paymentType === 'cod' ? 'cod' : 'mock_mpesa';
  const deliveryDate = text(data.deliveryDate, 80) || 'Today';
  const deliveryTime = text(data.deliveryTime, 40) || 'ASAP';
  const deliveryNotes = text(data.deliveryNotes, 600) || 'No specific instructions.';

  if (!DELIVERY_AREAS.has(deliveryArea)) {
    throw new HttpsError('invalid-argument', 'Select a valid delivery area.');
  }
  if (!/^(07|01)\d{8}$/.test(phone)) {
    throw new HttpsError('invalid-argument', 'Enter a valid Kenyan phone number.');
  }
  if (!Array.isArray(data.items) || data.items.length === 0 || data.items.length > 25) {
    throw new HttpsError('invalid-argument', 'Your cart must contain between 1 and 25 dishes.');
  }

  const requestedQuantities = new Map();
  for (const item of data.items) {
    const dishId = text(item?.dishId, 200);
    const quantity = Number(item?.qty);
    if (!dishId || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      throw new HttpsError('invalid-argument', 'One or more cart items are invalid.');
    }
    requestedQuantities.set(dishId, (requestedQuantities.get(dishId) || 0) + quantity);
  }

  for (const quantity of requestedQuantities.values()) {
    if (quantity > 20) {
      throw new HttpsError('invalid-argument', 'A maximum of 20 portions per dish is allowed.');
    }
  }

  const dishIds = [...requestedQuantities.keys()];
  const menuSnapshots = await db.getAll(...dishIds.map((dishId) => db.collection('menu').doc(dishId)));
  const groupedOrders = new Map();

  for (const menuSnapshot of menuSnapshots) {
    if (!menuSnapshot.exists) {
      throw new HttpsError('not-found', 'A selected dish is no longer available. Refresh the menu and try again.');
    }

    const dish = menuSnapshot.data();
    const ownerEmail = text(dish.ownerEmail, 254).toLowerCase();
    const pickupZone = text(dish.pickupZone) || 'Main Kitchen';
    const rawPrice = Number(dish.rawPrice);
    const quantity = requestedQuantities.get(menuSnapshot.id);

    if (!ownerEmail || !Number.isFinite(rawPrice) || rawPrice <= 0) {
      throw new HttpsError('failed-precondition', 'A selected dish has incomplete menu data.');
    }

    const orderItem = {
      dishId: menuSnapshot.id,
      title: `${text(dish.topTitle)} ${text(dish.bottomTitle)}`.trim(),
      chef: text(dish.chef) || 'Chef',
      ownerEmail,
      pickupZone,
      price: Math.round(rawPrice),
      qty: quantity,
      image: text(dish.image, 1000)
    };

    if (!groupedOrders.has(ownerEmail)) groupedOrders.set(ownerEmail, []);
    groupedOrders.get(ownerEmail).push(orderItem);
  }

  const customerEmail = request.auth.token.email.toLowerCase();
  const customerName = text(request.auth.token.name, 120) || customerEmail.split('@')[0];
  const masterOrderId = db.collection('orders').doc().id.slice(0, 10).toUpperCase();
  const batch = db.batch();
  let grandTotal = 0;

  for (const [ownerEmail, items] of groupedOrders) {
    const foodSubtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
    const specificDeliveryFee = deliveryFee(items[0].pickupZone, deliveryArea);
    const platformFee = Math.ceil(foodSubtotal * 0.1);
    const totalAmount = foodSubtotal + specificDeliveryFee;
    const orderRef = db.collection('orders').doc();

    batch.set(orderRef, {
      masterOrderId,
      subOrderId: `${masterOrderId}-${text(items[0].chef, 40).toUpperCase().replace(/\s+/g, '')}`,
      pickupZone: items[0].pickupZone,
      ownerEmail,
      chefPhone: text(menuSnapshots.find((snapshot) => snapshot.id === items[0].dishId)?.data()?.phone, 30) || 'Not provided',
      customerEmail,
      customerName,
      customerPhone: phone,
      paymentMethod: paymentType === 'cod' ? 'Pay on Delivery' : 'Mock M-Pesa',
      paymentStatus: paymentType === 'cod' ? 'pending_collection' : 'simulated',
      deliveryNotes,
      items,
      totalAmount,
      foodSubtotal,
      deliveryFee: specificDeliveryFee,
      platformFee,
      chefPayout: foodSubtotal - platformFee,
      status: 'pending',
      deliveryArea,
      deliveryDate,
      deliveryTime,
      timestamp: FieldValue.serverTimestamp()
    });
    grandTotal += totalAmount;
  }

  await batch.commit();
  return { masterOrderId, orderCount: groupedOrders.size, totalAmount: grandTotal };
});

exports.toggleLike = onCall({ region: 'us-central1' }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Please sign in before liking a dish.');
  }

  const dishId = text(request.data?.dishId, 200);
  if (!dishId) throw new HttpsError('invalid-argument', 'Dish ID is required.');

  const dishRef = db.collection('menu').doc(dishId);
  const result = await db.runTransaction(async (transaction) => {
    const dishSnapshot = await transaction.get(dishRef);
    if (!dishSnapshot.exists) throw new HttpsError('not-found', 'Dish not found.');

    const likedBy = Array.isArray(dishSnapshot.data().likedBy) ? dishSnapshot.data().likedBy : [];
    const isLiked = likedBy.includes(request.auth.uid);
    transaction.update(dishRef, {
      likedBy: isLiked ? FieldValue.arrayRemove(request.auth.uid) : FieldValue.arrayUnion(request.auth.uid)
    });
    return { isLiked: !isLiked, likes: isLiked ? Math.max(0, likedBy.length - 1) : likedBy.length + 1 };
  });

  return result;
});
