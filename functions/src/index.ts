/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import {setGlobalOptions} from "firebase-functions/v2";
import {onDocumentUpdated} from "firebase-functions/v2/firestore";
import {onCall, HttpsError} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({maxInstances: 10});

if (admin.apps.length === 0) {
  admin.initializeApp();
}

type GeoPoint = {lat: number; lng: number};

const TARGET_COORDINATES: GeoPoint = {lat: 13.0674, lng: 80.2376};
const MAX_DISTANCE_METERS = 300;
const EARTH_RADIUS_METERS = 6371000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

const distanceBetweenMeters = (a: GeoPoint, b: GeoPoint): number => {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const haversine =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(haversine));
};

const extractValidLocation = (raw: unknown): GeoPoint | null => {
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof (raw as Record<string, unknown>).lat !== "number" ||
    typeof (raw as Record<string, unknown>).lng !== "number"
  ) {
    return null;
  }
  const {lat, lng} = raw as {lat: number; lng: number};
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return {lat, lng};
};

const resolveFcmToken = (data: Record<string, unknown>): string | null => {
  if (typeof data.fcmToken === "string" && data.fcmToken.trim().length > 0) {
    return data.fcmToken.trim();
  }

  if (Array.isArray(data.fcmTokens)) {
    const token = data.fcmTokens.find(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    ) as string | undefined;
    if (token) return token.trim();
  }
  return null;
};

export const notifyUserNearLocation = onDocumentUpdated(
  "owners/{ownerId}/users/{uid}",
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();

    if (!after) {
      logger.warn("Document deleted or unavailable for event", event.document);
      return;
    }

    const location = extractValidLocation(after.location);
    if (!location) {
      logger.debug("No valid location on user; skipping", {
        doc: event.document,
      });
      return;
    }

    const beforeLocation = extractValidLocation(before?.location);
    if (
      beforeLocation &&
      beforeLocation.lat === location.lat &&
      beforeLocation.lng === location.lng
    ) {
      logger.debug("Location unchanged; skipping notification", {
        doc: event.document,
      });
      return;
    }

    const distance = distanceBetweenMeters(location, TARGET_COORDINATES);
    if (distance > MAX_DISTANCE_METERS) {
      logger.debug("User not within radius", {doc: event.document, distance});
      return;
    }

    const token = resolveFcmToken(after);
    if (!token) {
      logger.warn("No FCM token for user; cannot notify", {
        doc: event.document,
      });
      return;
    }

    await admin.messaging().send({
      token,
      notification: {
        title: "Welcome!",
        body: "You are near our location.",
      },
      data: {
        ownerId: event.params.ownerId,
        userId: event.params.uid,
        distanceMeters: distance.toFixed(2),
      },
    });

    logger.info("Sent proximity notification", {
      doc: event.document,
      distance,
    });

    const now = admin.firestore.Timestamp.now();
    const normalizeTimestamp = (
      value: unknown,
    ): admin.firestore.Timestamp | null => {
      if (value instanceof admin.firestore.Timestamp) {
        return value;
      }
      if (
        value &&
        typeof value === "object" &&
        typeof (value as {seconds?: number}).seconds === "number"
      ) {
        return new admin.firestore.Timestamp(
          (value as {seconds: number; nanoseconds?: number}).seconds,
          (value as {seconds: number; nanoseconds?: number}).nanoseconds ?? 0,
        );
      }
      if (typeof value === "number") {
        return admin.firestore.Timestamp.fromMillis(value);
      }
      return null;
    };

    const recentEntriesRaw = Array.isArray(after.recentEntries)
      ? after.recentEntries
      : [];
    const filteredEntries = recentEntriesRaw
      .map((entry) => normalizeTimestamp(entry))
      .filter(
        (entry): entry is admin.firestore.Timestamp =>
          !!entry && now.toMillis() - entry.toMillis() <= SEVEN_DAYS_MS,
      );
    filteredEntries.push(now);

    const db = admin.firestore();
    const userRef = db.doc(event.document);
    await userRef.update({recentEntries: filteredEntries});

    if (filteredEntries.length >= 3) {
      const ownerRef = userRef.parent.parent;
      if (!ownerRef) {
        logger.warn("Unable to resolve owner reference for", event.document);
        return;
      }
      const regularRef = ownerRef
        .collection("regularUsers")
        .doc(event.params.uid);
      const payload = {
        ...after,
        recentEntries: filteredEntries,
        becameRegularAt: now,
      };
      await regularRef.set(payload);
      await userRef.delete();
      logger.info("Promoted user to regulars", {
        doc: event.document,
        entriesThisWeek: filteredEntries.length,
      });
    }
  },
);

const isBossAdmin = (email: string | undefined | null): boolean => {
  if (!email) return false;
  const normalized = email.toLowerCase().trim();
  return (
    normalized === "boss@foodeepicker.com" ||
    normalized.endsWith("@foodeepicker.com")
  );
};

const FREE_PLAN_USER_LIMIT = 100;

export const sendManualMessage = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Owner must be signed in.");
  }

  const ownerId = (request.data?.ownerId ?? "").toString().trim();
  const message = (request.data?.message ?? "").toString().trim();
  const includeRegular: boolean =
    request.data?.includeRegularUsers !== false;

  if (!ownerId) {
    throw new HttpsError("invalid-argument", "ownerId is required.");
  }
  if (!message) {
    throw new HttpsError("invalid-argument", "Message body is required.");
  }

  const db = admin.firestore();
  const ownerRef = db.collection("owners").doc(ownerId);
  const ownerDoc = await ownerRef.get();

  if (!ownerDoc.exists) {
    throw new HttpsError("not-found", "Owner not found.");
  }

  const ownerData = ownerDoc.data();
  const subscriptionPlan = (ownerData?.subscriptionPlan || "free") as string;
  const isActive = ownerData?.active !== false;

  if (!isActive) {
    throw new HttpsError(
      "permission-denied",
      "Owner account is deactivated."
    );
  }

  if (subscriptionPlan === "free") {
    throw new HttpsError(
      "permission-denied",
      "Manual messaging is not available on the free plan. Upgrade to premium to send messages."
    );
  }

  const [usersSnap, regularSnap] = await Promise.all([
    ownerRef.collection("users").get(),
    includeRegular ? ownerRef.collection("regularUsers").get() : null,
  ]);

  const tokens = new Set<string>();
  const collectTokens = (snapshot: FirebaseFirestore.QuerySnapshot | null) => {
    snapshot?.forEach((doc) => {
      const token = resolveFcmToken(doc.data());
      if (token) tokens.add(token);
    });
  };

  collectTokens(usersSnap);
  collectTokens(regularSnap);

  if (!tokens.size) {
    logger.info("sendManualMessage skipped; no tokens for owner", {ownerId});
    return {successCount: 0, failureCount: 0, totalTokens: 0};
  }

  const tokenList = Array.from(tokens);
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < tokenList.length; i += 500) {
    const batch = tokenList.slice(i, i + 500);
    const response = await admin.messaging().sendEachForMulticast({
      tokens: batch,
      notification: {
        title: "Foodee Picker",
        body: message,
      },
      data: {
        ownerId,
        manual: "true",
      },
    });
    successCount += response.successCount;
    failureCount += response.failureCount;
  }

  logger.info("sendManualMessage delivered", {
    ownerId,
    successCount,
    failureCount,
  });

  return {
    successCount,
    failureCount,
    totalTokens: tokenList.length,
  };
});

export const checkUserLimit = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be signed in.");
  }

  const ownerId = (request.data?.ownerId ?? "").toString().trim();
  if (!ownerId) {
    throw new HttpsError("invalid-argument", "ownerId is required.");
  }

  const db = admin.firestore();
  const ownerRef = db.collection("owners").doc(ownerId);
  const ownerDoc = await ownerRef.get();

  if (!ownerDoc.exists) {
    throw new HttpsError("not-found", "Owner not found.");
  }

  const ownerData = ownerDoc.data();
  const subscriptionPlan = (ownerData?.subscriptionPlan || "free") as string;

  if (subscriptionPlan === "premium") {
    return { allowed: true, current: 0, limit: Infinity };
  }

  const usersSnap = await ownerRef.collection("users").get();
  const currentCount = usersSnap.size;

  if (currentCount >= FREE_PLAN_USER_LIMIT) {
    return {
      allowed: false,
      current: currentCount,
      limit: FREE_PLAN_USER_LIMIT,
    };
  }

  return {
    allowed: true,
    current: currentCount,
    limit: FREE_PLAN_USER_LIMIT,
  };
});

export const updateOwnerSubscription = onCall(async (request) => {
  if (!request.auth || !isBossAdmin(request.auth.token.email)) {
    throw new HttpsError(
      "permission-denied",
      "Only boss admin can update subscriptions."
    );
  }

  const ownerId = (request.data?.ownerId ?? "").toString().trim();
  const subscriptionPlan = (request.data?.subscriptionPlan ?? "").toString()
    .trim()
    .toLowerCase();

  if (!ownerId) {
    throw new HttpsError("invalid-argument", "ownerId is required.");
  }

  if (subscriptionPlan !== "free" && subscriptionPlan !== "premium") {
    throw new HttpsError(
      "invalid-argument",
      "subscriptionPlan must be 'free' or 'premium'."
    );
  }

  const db = admin.firestore();
  const ownerRef = db.collection("owners").doc(ownerId);
  const ownerDoc = await ownerRef.get();

  if (!ownerDoc.exists) {
    throw new HttpsError("not-found", "Owner not found.");
  }

  await ownerRef.update({
    subscriptionPlan,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  logger.info("Updated owner subscription", { ownerId, subscriptionPlan });

  return { success: true, ownerId, subscriptionPlan };
});

export const toggleOwnerStatus = onCall(async (request) => {
  if (!request.auth || !isBossAdmin(request.auth.token.email)) {
    throw new HttpsError(
      "permission-denied",
      "Only boss admin can toggle owner status."
    );
  }

  const ownerId = (request.data?.ownerId ?? "").toString().trim();
  const active = request.data?.active === true;

  if (!ownerId) {
    throw new HttpsError("invalid-argument", "ownerId is required.");
  }

  const db = admin.firestore();
  const ownerRef = db.collection("owners").doc(ownerId);
  const ownerDoc = await ownerRef.get();

  if (!ownerDoc.exists) {
    throw new HttpsError("not-found", "Owner not found.");
  }

  await ownerRef.update({
    active,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  logger.info("Toggled owner status", { ownerId, active });

  return { success: true, ownerId, active };
});

export const deleteOwner = onCall(async (request) => {
  if (!request.auth || !isBossAdmin(request.auth.token.email)) {
    throw new HttpsError(
      "permission-denied",
      "Only boss admin can delete owners."
    );
  }

  const ownerId = (request.data?.ownerId ?? "").toString().trim();
  if (!ownerId) {
    throw new HttpsError("invalid-argument", "ownerId is required.");
  }

  const db = admin.firestore();
  const ownerRef = db.collection("owners").doc(ownerId);
  const ownerDoc = await ownerRef.get();

  if (!ownerDoc.exists) {
    throw new HttpsError("not-found", "Owner not found.");
  }

  const batch = db.batch();

  const [usersSnap, regularSnap] = await Promise.all([
    ownerRef.collection("users").get(),
    ownerRef.collection("regularUsers").get(),
  ]);

  usersSnap.forEach((doc) => batch.delete(doc.ref));
  regularSnap.forEach((doc) => batch.delete(doc.ref));
  batch.delete(ownerRef);

  await batch.commit();

  logger.info("Deleted owner and all subcollections", { ownerId });

  return { success: true, ownerId };
});
