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
  },
);
