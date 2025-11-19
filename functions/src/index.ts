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
import {onSchedule} from "firebase-functions/v2/scheduler";
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

export const scheduleMessage = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Owner must be signed in.");
  }

  const ownerId = (request.data?.ownerId ?? "").toString().trim();
  const message = (request.data?.message ?? "").toString().trim();
  const target = (request.data?.target ?? "all").toString().trim();
  const scheduledAt = request.data?.scheduledAt;

  if (!ownerId) {
    throw new HttpsError("invalid-argument", "ownerId is required.");
  }
  if (!message) {
    throw new HttpsError("invalid-argument", "Message body is required.");
  }
  if (!scheduledAt) {
    throw new HttpsError("invalid-argument", "scheduledAt is required.");
  }

  const db = admin.firestore();
  const ownerRef = db.collection("owners").doc(ownerId);
  const ownerDoc = await ownerRef.get();

  if (!ownerDoc.exists) {
    throw new HttpsError("not-found", "Owner not found.");
  }

  const ownerData = ownerDoc.data();
  const subscriptionPlan = (ownerData?.subscriptionPlan || "free") as string;

  if (subscriptionPlan === "free") {
    throw new HttpsError(
      "permission-denied",
      "Scheduling messages is not available on the free plan. Upgrade to premium."
    );
  }

  let scheduledTimestamp: admin.firestore.Timestamp;
  if (scheduledAt instanceof admin.firestore.Timestamp) {
    scheduledTimestamp = scheduledAt;
  } else if (
    scheduledAt &&
    typeof scheduledAt === "object" &&
    typeof (scheduledAt as {seconds?: number}).seconds === "number"
  ) {
    scheduledTimestamp = new admin.firestore.Timestamp(
      (scheduledAt as {seconds: number; nanoseconds?: number}).seconds,
      (scheduledAt as {seconds: number; nanoseconds?: number}).nanoseconds ?? 0,
    );
  } else {
    throw new HttpsError("invalid-argument", "Invalid scheduledAt format.");
  }

  const now = admin.firestore.Timestamp.now();
  if (scheduledTimestamp.toMillis() <= now.toMillis()) {
    throw new HttpsError(
      "invalid-argument",
      "Scheduled time must be in the future."
    );
  }

  const validTargets = ["normal", "regular", "premium", "all"];
  if (!validTargets.includes(target)) {
    throw new HttpsError(
      "invalid-argument",
      `Target must be one of: ${validTargets.join(", ")}`
    );
  }

  const scheduledMessageRef = ownerRef.collection("scheduledMessages").doc();
  await scheduledMessageRef.set({
    ownerId,
    message,
    target,
    scheduledAt: scheduledTimestamp,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  logger.info("Scheduled message created", {
    ownerId,
    messageId: scheduledMessageRef.id,
    scheduledAt: scheduledTimestamp.toMillis(),
  });

  return {
    success: true,
    messageId: scheduledMessageRef.id,
    scheduledAt: scheduledTimestamp.toMillis(),
  };
});

const sendScheduledMessage = async (
  ownerId: string,
  message: string,
  target: string,
  messageId: string,
): Promise<void> => {
  const db = admin.firestore();
  const ownerRef = db.collection("owners").doc(ownerId);

  const tokens = new Set<string>();

  if (target === "all" || target === "normal") {
    const usersSnap = await ownerRef.collection("users").get();
    usersSnap.forEach((doc) => {
      const token = resolveFcmToken(doc.data());
      if (token) tokens.add(token);
    });
  }

  if (target === "all" || target === "regular") {
    const regularSnap = await ownerRef.collection("regularUsers").get();
    regularSnap.forEach((doc) => {
      const token = resolveFcmToken(doc.data());
      if (token) tokens.add(token);
    });
  }

  if (target === "premium") {
    const regularSnap = await ownerRef.collection("regularUsers").get();
    regularSnap.forEach((doc) => {
      const token = resolveFcmToken(doc.data());
      if (token) tokens.add(token);
    });
  }

  if (!tokens.size) {
    logger.info("Scheduled message skipped; no tokens", { ownerId, messageId });
    await ownerRef
      .collection("scheduledMessages")
      .doc(messageId)
      .update({ status: "sent", sentAt: admin.firestore.FieldValue.serverTimestamp() });
    return;
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
        scheduled: "true",
        messageId,
      },
    });
    successCount += response.successCount;
    failureCount += response.failureCount;
  }

  await ownerRef
    .collection("scheduledMessages")
    .doc(messageId)
    .update({
      status: "sent",
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      successCount,
      failureCount,
    });

  logger.info("Scheduled message sent", {
    ownerId,
    messageId,
    successCount,
    failureCount,
  });
};

export const checkScheduledMessages = onSchedule("every 1 minutes", async () => {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();

  const ownersSnap = await db.collection("owners").get();

  for (const ownerDoc of ownersSnap.docs) {
    const ownerId = ownerDoc.id;
    const ownerData = ownerDoc.data();

    if (ownerData.active === false) {
      continue;
    }

    const pendingSnap = await db
      .collection("owners")
      .doc(ownerId)
      .collection("scheduledMessages")
      .where("status", "==", "pending")
      .where("scheduledAt", "<=", now)
      .limit(10)
      .get();

    for (const msgDoc of pendingSnap.docs) {
      const msgData = msgDoc.data();
      try {
        await sendScheduledMessage(
          ownerId,
          msgData.message as string,
          msgData.target as string,
          msgDoc.id,
        );
      } catch (error) {
        logger.error("Failed to send scheduled message", {
          ownerId,
          messageId: msgDoc.id,
          error,
        });
        await db
          .collection("owners")
          .doc(ownerId)
          .collection("scheduledMessages")
          .doc(msgDoc.id)
          .update({
            status: "failed",
            error: (error as Error).message,
          });
      }
    }
  }
});

export const generateAIGreeting = onCall(async (request) => {
  const ownerId = (request.data?.ownerId ?? "").toString().trim();
  const timeOfDay = (request.data?.timeOfDay ?? "").toString().trim();

  if (!ownerId) {
    throw new HttpsError("invalid-argument", "ownerId is required.");
  }

  const validTimes = ["morning", "afternoon", "evening"];
  if (!validTimes.includes(timeOfDay)) {
    throw new HttpsError(
      "invalid-argument",
      `timeOfDay must be one of: ${validTimes.join(", ")}`
    );
  }

  const db = admin.firestore();
  const ownerRef = db.collection("owners").doc(ownerId);
  const ownerDoc = await ownerRef.get();

  if (!ownerDoc.exists) {
    throw new HttpsError("not-found", "Owner not found.");
  }

  const ownerData = ownerDoc.data();
  if (ownerData?.aiMode !== true) {
    throw new HttpsError(
      "permission-denied",
      "AI Mode is not enabled for this owner."
    );
  }

  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    logger.warn("OpenAI API key not configured; using fallback greeting");
    const fallbackGreetings = {
      morning: "Good morning! Start your day with great food from Foodee Picker! 🌅",
      afternoon: "Good afternoon! Hope you're having a wonderful day. Check out our special offers! ☀️",
      evening: "Good evening! Time to unwind with delicious food from Foodee Picker! 🌙",
    };
    return {
      greeting: fallbackGreetings[timeOfDay as keyof typeof fallbackGreetings],
      source: "fallback",
    };
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content:
              "You are a friendly assistant for Foodee Picker, a food delivery/pickup service. Generate warm, concise greetings (under 100 characters) appropriate for the time of day.",
          },
          {
            role: "user",
            content: `Generate a ${timeOfDay} greeting for Foodee Picker customers. Keep it friendly and brief.`,
          },
        ],
        max_tokens: 100,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{message?: {content?: string}}>;
    };
    const greeting =
      data.choices?.[0]?.message?.content?.trim() ||
      `Good ${timeOfDay}! Enjoy Foodee Picker today!`;

    return { greeting, source: "openai" };
  } catch (error) {
    logger.error("OpenAI greeting generation failed", { ownerId, error });
    const fallbackGreetings = {
      morning: "Good morning! Start your day with great food from Foodee Picker! 🌅",
      afternoon: "Good afternoon! Hope you're having a wonderful day. Check out our special offers! ☀️",
      evening: "Good evening! Time to unwind with delicious food from Foodee Picker! 🌙",
    };
    return {
      greeting: fallbackGreetings[timeOfDay as keyof typeof fallbackGreetings],
      source: "fallback",
    };
  }
});

const generateGreetingText = async (
  timeOfDay: string,
): Promise<string> => {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    logger.warn("OpenAI API key not configured; using fallback greeting");
    const fallbackGreetings = {
      morning: "Good morning! Start your day with great food from Foodee Picker! 🌅",
      afternoon: "Good afternoon! Hope you're having a wonderful day. Check out our special offers! ☀️",
      evening: "Good evening! Time to unwind with delicious food from Foodee Picker! 🌙",
    };
    return fallbackGreetings[timeOfDay as keyof typeof fallbackGreetings];
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content:
              "You are a friendly assistant for Foodee Picker, a food delivery/pickup service. Generate warm, concise greetings (under 100 characters) appropriate for the time of day.",
          },
          {
            role: "user",
            content: `Generate a ${timeOfDay} greeting for Foodee Picker customers. Keep it friendly and brief.`,
          },
        ],
        max_tokens: 100,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{message?: {content?: string}}>;
    };
    return (
      data.choices?.[0]?.message?.content?.trim() ||
      `Good ${timeOfDay}! Enjoy Foodee Picker today!`
    );
  } catch (error) {
    logger.error("OpenAI greeting generation failed", { error });
    const fallbackGreetings = {
      morning: "Good morning! Start your day with great food from Foodee Picker! 🌅",
      afternoon: "Good afternoon! Hope you're having a wonderful day. Check out our special offers! ☀️",
      evening: "Good evening! Time to unwind with delicious food from Foodee Picker! 🌙",
    };
    return fallbackGreetings[timeOfDay as keyof typeof fallbackGreetings];
  }
};

export const sendAIGreetings = onSchedule("0 8,14,19 * * *", async () => {
  const db = admin.firestore();
  const now = new Date();
  const hour = now.getHours();

  let timeOfDay: string;
  if (hour >= 5 && hour < 12) {
    timeOfDay = "morning";
  } else if (hour >= 12 && hour < 17) {
    timeOfDay = "afternoon";
  } else {
    timeOfDay = "evening";
  }

  const ownersSnap = await db
    .collection("owners")
    .where("aiMode", "==", true)
    .where("active", "!=", false)
    .get();

  const greeting = await generateGreetingText(timeOfDay);

  for (const ownerDoc of ownersSnap.docs) {
    const ownerId = ownerDoc.id;
    const ownerData = ownerDoc.data();

    if (ownerData.active === false) {
      continue;
    }

    try {
      const [usersSnap, regularSnap] = await Promise.all([
        db.collection("owners").doc(ownerId).collection("users").get(),
        db.collection("owners").doc(ownerId).collection("regularUsers").get(),
      ]);

      const tokens = new Set<string>();
      const collectTokens = (snapshot: FirebaseFirestore.QuerySnapshot) => {
        snapshot.forEach((doc) => {
          const token = resolveFcmToken(doc.data());
          if (token) tokens.add(token);
        });
      };

      collectTokens(usersSnap);
      collectTokens(regularSnap);

      if (!tokens.size) {
        logger.info("No tokens for AI greeting", { ownerId });
        continue;
      }

      const tokenList = Array.from(tokens);
      for (let i = 0; i < tokenList.length; i += 500) {
        const batch = tokenList.slice(i, i + 500);
        await admin.messaging().sendEachForMulticast({
          tokens: batch,
          notification: {
            title: "Foodee Picker",
            body: greeting,
          },
          data: {
            ownerId,
            aiGreeting: "true",
            timeOfDay,
          },
        });
      }

      logger.info("Sent AI greeting", { ownerId, timeOfDay });
    } catch (error) {
      logger.error("Failed to send AI greeting", { ownerId, error });
    }
  }
});
