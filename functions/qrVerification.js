const crypto = require("crypto");

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const {
  getFirestore,
  FieldValue,
  Timestamp,
} = require("firebase-admin/firestore");

const db = getFirestore();

const QR_TOKEN_LIFETIME_SECONDS = 120;
const REGION = "us-central1";

/**
 * Convert Firestore timestamps into ISO strings recursively.
 * This also supports timestamps nested in arrays or maps.
 */
function serializeFirestoreValue(value) {
  if (value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(serializeFirestoreValue);
  }

  if (value && typeof value === "object") {
    const result = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      result[key] = serializeFirestoreValue(nestedValue);
    }

    return result;
  }

  return value;
}

/**
 * Create a temporary QR token for a signed-in, verified user.
 */
const createQRCodeToken = onCall(
  { region: REGION },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "You must be signed in to generate a verification QR code."
      );
    }

    const uid = request.auth.uid;

    try {
      const verificationSnapshot = await db
        .collection("verificationRecords")
        .doc(uid)
        .get();

      if (
        !verificationSnapshot.exists ||
        verificationSnapshot.data().status !== "verified"
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Your identity must be verified before generating a QR code."
        );
      }

      const token = crypto.randomBytes(32).toString("hex");
      const now = Timestamp.now();

      const expiresAt = Timestamp.fromMillis(
        now.toMillis() + QR_TOKEN_LIFETIME_SECONDS * 1000
      );

      await db.collection("qrTokens").doc(token).set({
        uid,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt,
        used: false,
      });

      return {
        success: true,
        verificationURL:
          `https://careconnect-3bd75.web.app/v/${token}`,
        expiresInSeconds: QR_TOKEN_LIFETIME_SECONDS,
      };
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }

      console.error("createQRCodeToken failed:", {
        message: error.message,
        code: error.code || null,
      });

      throw new HttpsError(
        "internal",
        "Unable to create your verification QR code."
      );
    }
  }
);

/**
 * Get up to three upcoming committed help-card events.
 * Calendar failures do not prevent QR verification.
 */
async function getUpcomingEvents(uid) {
  try {
    const [ownedCardsSnapshot, acceptedCardsSnapshot] =
      await Promise.all([
        db.collectionGroup("helpCards")
          .where("ownerId", "==", uid)
          .get(),

        db.collectionGroup("helpCards")
          .where("committedBy", "==", uid)
          .get(),
      ]);

    console.log("QR calendar query results:", {
      ownedCards: ownedCardsSnapshot.size,
      acceptedCards: acceptedCardsSnapshot.size,
    });

    const cardsByPath = new Map();

    for (const doc of [
      ...ownedCardsSnapshot.docs,
      ...acceptedCardsSnapshot.docs,
    ]) {
      cardsByPath.set(doc.ref.path, doc);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const weekEnd = new Date(today);
    weekEnd.setDate(weekEnd.getDate() + 7);

    function toEventDate(value) {
      if (value && typeof value.toDate === "function") {
        return value.toDate();
      }

      if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
      }

      if (typeof value === "string" || typeof value === "number") {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
      }

      return null;
    }

    const typeLabels = {
      help_offer: "Help Offer",
      support_request: "Support Request",
    };

    const upcomingEvents = [];

    for (const doc of cardsByPath.values()) {
      const card = doc.data();

      if (
        card.isCommitted !== true ||
        (card.ownerId !== uid && card.committedBy !== uid)
      ) {
        continue;
      }

      const dates = Array.isArray(card.availabilityDates)
        ? card.availabilityDates
        : [];

      for (const value of dates) {
        const date = toEventDate(value);

        if (!date || date < today || date >= weekEnd) {
          continue;
        }

        upcomingEvents.push({
          id: `${doc.id}_${date.getTime()}`,
          title: card.title || "Accepted Help Opportunity",
          type:
            typeLabels[card.postType] ||
            "Accepted Help Opportunity",
          date: date.toISOString(),
        });
      }
    }

    upcomingEvents.sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );

    return upcomingEvents.slice(0, 3);
  } catch (error) {
    console.error("QR calendar lookup failed:", {
      message: error.message,
      code: error.code || null,
    });

    return [];
  }
}

/**
 * Read and normalize medication records from:
 * users/{uid}/medications/{medicationId}
 */
async function getUserMedications(uid, userData) {
  try {
    const medicationsRef = db
      .collection("users")
      .doc(uid)
      .collection("medications");

    const medicationsSnapshot = await medicationsRef.get();

    console.log("QR medication lookup:", {
      uid,
      path: medicationsRef.path,
      count: medicationsSnapshot.size,
      fieldNames: medicationsSnapshot.docs.map((doc) =>
        Object.keys(doc.data())
      ),
    });

    let rawMedications = medicationsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Fallback for installations storing medication arrays on the profile.
    if (rawMedications.length === 0) {
      const profileMedications = Array.isArray(userData.medications)
        ? userData.medications
        : Array.isArray(userData.medicationList)
          ? userData.medicationList
          : [];

      rawMedications = profileMedications.map((med, index) => ({
        id: med.id || `profile_med_${index}`,
        ...med,
      }));
    }

    const medications = rawMedications.map((med) => ({
      id: String(med.id || med.medicationId || ""),
      name:
        med.name ||
        med.medicationName ||
        med.medication ||
        med.medicine ||
        "Unnamed medication",

      dosage: med.dosage || med.dose || med.strength || "",

      // Recurring schedule.
      scheduleDays: Array.isArray(med.scheduleDays)
        ? med.scheduleDays
        : [],

      times: Array.isArray(med.times)
        ? serializeFirestoreValue(med.times)
        : med.times
          ? [serializeFirestoreValue(med.times)]
          : [],

      frequency:
        med.frequency ||
        med.howOften ||
        med.schedule ||
        "",

      instructions:
        med.instructions ||
        med.directions ||
        med.notes ||
        med.administrationInstructions ||
        "",

      // Medication tracking.
      streak: Number.isFinite(Number(med.streak))
        ? Number(med.streak)
        : null,

      lastTaken: med.lastTaken
        ? serializeFirestoreValue(med.lastTaken)
        : null,

      takenTimes: Array.isArray(med.takenTimes)
        ? serializeFirestoreValue(med.takenTimes)
        : [],

      takenTimesActual: med.takenTimesActual &&
        typeof med.takenTimesActual === "object"
        ? serializeFirestoreValue(med.takenTimesActual)
        : {},

      // Additional common fields, when present.
      startDate: med.startDate
        ? serializeFirestoreValue(med.startDate)
        : null,

      endDate: med.endDate
        ? serializeFirestoreValue(med.endDate)
        : null,

      notes: med.notes || "",
    }));

    console.log("QR medication response summary:", {
      count: medications.length,
      medications: medications.map((med) => ({
        id: med.id,
        name: med.name,
        hasDosage: Boolean(med.dosage),
        scheduleDays: med.scheduleDays,
        timesCount: med.times.length,
        hasLastTaken: Boolean(med.lastTaken),
        streak: med.streak,
      })),
    });

    return medications;
  } catch (error) {
    console.error("QR medication lookup failed:", {
      message: error.message,
      code: error.code || null,
    });

    return [];
  }
}

/**
 * Validate and consume a QR token, then return the verified profile.
 */
const resolveQRCodeToken = onCall(
  { region: REGION },
  async (request) => {
    const token = request.data?.token;

    if (
      typeof token !== "string" ||
      !/^[a-f0-9]{64}$/.test(token)
    ) {
      throw new HttpsError(
        "invalid-argument",
        "Invalid verification token."
      );
    }

    try {
      const tokenRef = db.collection("qrTokens").doc(token);

      const result = await db.runTransaction(async (transaction) => {
        const tokenSnapshot = await transaction.get(tokenRef);

        if (!tokenSnapshot.exists) {
          throw new HttpsError(
            "not-found",
            "This verification code is invalid or expired."
          );
        }

        const tokenData = tokenSnapshot.data();

        if (tokenData.used === true) {
          throw new HttpsError(
            "failed-precondition",
            "This verification code has already been used."
          );
        }

        const expiresAt = tokenData.expiresAt;

        if (
          !expiresAt ||
          typeof expiresAt.toMillis !== "function" ||
          expiresAt.toMillis() <= Date.now()
        ) {
          throw new HttpsError(
            "deadline-exceeded",
            "This verification code has expired."
          );
        }

        const uid = tokenData.uid;

        if (typeof uid !== "string" || !uid) {
          throw new HttpsError(
            "failed-precondition",
            "The verification token has no valid user."
          );
        }

        const verificationRef = db
          .collection("verificationRecords")
          .doc(uid);

        const userRef = db.collection("users").doc(uid);

        const verificationSnapshot = await transaction.get(
          verificationRef
        );

        const userSnapshot = await transaction.get(userRef);

        if (
          !verificationSnapshot.exists ||
          verificationSnapshot.data().status !== "verified"
        ) {
          throw new HttpsError(
            "permission-denied",
            "This user's identity is not verified."
          );
        }

        if (!userSnapshot.exists) {
          throw new HttpsError(
            "not-found",
            "The user's profile could not be found."
          );
        }

        const userData = userSnapshot.data();

        transaction.update(tokenRef, {
          used: true,
          usedAt: FieldValue.serverTimestamp(),
        });

        return {
          uid,
          success: true,
          verified: true,
          displayName:
            userData.name ||
            userData.displayName ||
            "Name unavailable",
          email: userData.email || "",
          city: userData.city || "",
          state: userData.state || "",
          verificationStatus: "verified",
          userData,
        };
      });

      const [upcomingEvents, medications] = await Promise.all([
        getUpcomingEvents(result.uid),
        getUserMedications(result.uid, result.userData),
      ]);

      // Never return the internal UID or full user document to the page.
      delete result.uid;
      delete result.userData;

      return {
        ...result,
        medications,
        upcomingEvents,
      };
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }

      console.error("resolveQRCodeToken failed:", {
        message: error.message,
        code: error.code || null,
      });

      throw new HttpsError(
        "internal",
        "Unable to verify this QR code."
      );
    }
  }
);

module.exports = {
  createQRCodeToken,
  resolveQRCodeToken,
};