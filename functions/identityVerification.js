const crypto = require("crypto");

const {
  onCall,
  onRequest,
} = require("firebase-functions/v2/https");

const { defineSecret } = require("firebase-functions/params");
const functions = require("firebase-functions");

const { initializeApp } = require("firebase-admin/app");
const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

initializeApp();

const DIDIT_API_KEY = defineSecret("DIDIT_API_KEY");
const DIDIT_WEBHOOK_SECRET = defineSecret(
  "DIDIT_WEBHOOK_SECRET"
);

const DIDIT_WORKFLOW_ID =
  "9a045e4b-9a47-4275-8f93-e61a41d7380f";

const db = getFirestore();


/*
 * Creates a new Didit verification session
 * for the signed-in CareConnect user.
 */
const createIdentityVerification = onCall(
  {
    secrets: [DIDIT_API_KEY],
    region: "us-central1",
  },
  async (request) => {
    if (!request.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "You must be signed in to begin identity verification."
      );
    }

    const uid = request.auth.uid;

    try {
      await getAuth().getUser(uid);

      const verificationRef = db
        .collection("verificationRecords")
        .doc(uid);

      await verificationRef.set(
        {
          status: "processing",
          provider: "didit",
          verificationLevel: "identity",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      const response = await fetch(
        "https://verification.didit.me/v3/session/",
        {
          method: "POST",
          headers: {
            "x-api-key": DIDIT_API_KEY.value(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workflow_id: DIDIT_WORKFLOW_ID,
            vendor_data: uid,
          }),
        }
      );

      const responseText = await response.text();

      if (!response.ok) {
        console.error(
          "Didit session creation failed:",
          response.status,
          responseText
        );

        throw new functions.https.HttpsError(
          "internal",
          "Didit could not create an identity verification session."
        );
      }

      let diditSession;

      try {
        diditSession = JSON.parse(responseText);
      } catch (error) {
        console.error(
          "Could not parse Didit response:",
          responseText
        );

        throw new functions.https.HttpsError(
          "internal",
          "Didit returned an invalid response."
        );
      }

      const verificationURL =
        diditSession.url ||
        diditSession.session_url;

      if (!verificationURL) {
        console.error(
          "Didit response did not contain a verification URL:",
          diditSession
        );

        throw new functions.https.HttpsError(
          "internal",
          "Didit did not return a verification URL."
        );
      }

      await verificationRef.set(
        {
          diditSessionId:
            diditSession.session_id || null,
          status: "processing",
          provider: "didit",
          verificationLevel: "identity",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      console.log(
        `Created Didit session ${diditSession.session_id} for UID ${uid}`
      );

      return {
        success: true,
        sessionId:
          diditSession.session_id || null,
        verificationURL,
      };
    } catch (error) {
      console.error(
        "createIdentityVerification error:",
        error
      );

      if (error instanceof functions.https.HttpsError) {
        throw error;
      }

      throw new functions.https.HttpsError(
        "internal",
        "Unable to start identity verification."
      );
    }
  }
);


/*
 * Didit webhook.
 *
 * Didit sends status.updated events here.
 *
 * IMPORTANT:
 * This is a 2nd-gen HTTP function so the
 * secrets option is supported correctly.
 */
const diditWebhookV2 = onRequest(
  {
    secrets: [DIDIT_WEBHOOK_SECRET],
    region: "us-central1",
  },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res
          .status(405)
          .send("Method Not Allowed");
      }

      const rawBody = req.rawBody;

      if (!rawBody) {
        console.error(
          "Didit webhook: raw request body missing."
        );

        return res
          .status(400)
          .send("Missing request body");
      }

      const signatureHeader =
        req.headers["x-signature-v2"];

      const timestampHeader =
        req.headers["x-timestamp"];

      if (!signatureHeader || !timestampHeader) {
        console.error(
          "Didit webhook: missing signature headers."
        );

        return res
          .status(401)
          .send("Missing signature");
      }

      const timestamp =
        Number(timestampHeader);

      if (!Number.isFinite(timestamp)) {
        console.error(
          "Didist webhook: invalid timestamp."
        );

        return res
          .status(401)
          .send("Invalid timestamp");
      }

      const currentTimestamp =
        Math.floor(Date.now() / 1000);

      if (
        Math.abs(
          currentTimestamp - timestamp
        ) > 300
      ) {
        console.error(
          "Didit webhook: timestamp outside allowed window."
        );

        return res
          .status(401)
          .send("Expired webhook");
      }

      const webhookSecret =
        DIDIT_WEBHOOK_SECRET.value();

      if (!webhookSecret) {
        console.error(
          "Didit webhook: secret is empty."
        );

        return res
          .status(500)
          .send("Webhook secret not configured");
      }

      /*
       * Verify the webhook signature using
       * the raw request body.
       */
      const expectedSignature =
        crypto
          .createHmac(
            "sha256",
            webhookSecret
          )
          .update(rawBody)
          .digest("hex");

      const receivedSignature =
        String(signatureHeader);

      if (
        !safeCompare(
          expectedSignature,
          receivedSignature
        )
      ) {
        console.error(
          "Didit webhook: signature verification failed."
        );

        return res
          .status(401)
          .send("Invalid signature");
      }

      /*
       * Parse only after signature verification.
       */
      let payload;

      try {
        payload = JSON.parse(
          rawBody.toString("utf8")
        );
      } catch (error) {
        console.error(
          "Didit webhook: invalid JSON:",
          error
        );

        return res
          .status(400)
          .send("Invalid JSON");
      }

      console.log(
        "Didit webhook received:",
        JSON.stringify({
          webhook_type:
            payload.webhook_type,
          status:
            payload.status,
          session_id:
            payload.session_id,
          vendor_data:
            payload.vendor_data,
          environment:
            payload.environment,
        })
      );

      /*
       * Only process status.updated events.
       */
      if (
        payload.webhook_type !==
        "status.updated"
      ) {
        return res
          .status(200)
          .send("Event ignored");
      }

      const uid =
        payload.vendor_data;

      const sessionId =
        payload.session_id;

      const diditStatus =
        payload.status;

      const environment =
        payload.environment || null;

      if (!uid) {
        console.error(
          "Didit webhook: vendor_data missing."
        );

        return res
          .status(400)
          .send("Missing vendor_data");
      }

      if (!sessionId) {
        console.error(
          "Didit webhook: session_id missing."
        );

        return res
          .status(400)
          .send("Missing session_id");
      }

      if (!diditStatus) {
        console.error(
          "Didit webhook: status missing."
        );

        return res
          .status(400)
          .send("Missing status");
      }

      console.log(
        `Didit status for ${uid}: "${diditStatus}"`
      );

      /*
       * Map Didit statuses to CareConnect statuses.
       */
      let careConnectStatus;

      switch (diditStatus) {
        case "Approved":
          careConnectStatus = "verified";
          break;

        case "Declined":
          careConnectStatus = "rejected";
          break;

        case "In Review":
          careConnectStatus = "needs_review";
          break;

        case "In Progress":
        case "Not Started":
        case "Resubmitted":
        case "Awaiting User":
          careConnectStatus = "processing";
          break;

        case "Expired":
        case "Abandoned":
        case "Kyc Expired":
          careConnectStatus = "not_started";
          break;

        default:
          console.warn(
            `Unhandled Didit status: "${diditStatus}"`
          );

          return res
            .status(200)
            .send("Status not mapped");
      }

      const verificationRef =
        db
          .collection("verificationRecords")
          .doc(uid);

      const updateData = {
        status: careConnectStatus,
        provider: "didit",
        verificationLevel: "identity",
        diditStatus: diditStatus,
        diditSessionId: sessionId,
        diditEnvironment: environment,
        updatedAt:
          FieldValue.serverTimestamp(),
      };

      if (
        careConnectStatus ===
        "verified"
      ) {
        updateData.verifiedAt =
          FieldValue.serverTimestamp();

        const userSnapshot = await db
          .collection("users")
          .doc(uid)
          .get();

        if (!userSnapshot.exists) {
          console.error(
            `Cannot create verified profile: users/${uid} does not exist.`
          );

          return res
            .status(500)
            .send("User profile not found");
        }

        const userData =
          userSnapshot.data();

        await db
          .collection("verifiedProfiles")
          .doc(uid)
          .set(
            {
              displayName:
                userData.name || "CareConnect Member",

              role:
                userData.role || "unknown",

              verificationStatus:
                "verified",

              updatedAt:
                FieldValue.serverTimestamp(),
            },
            {
              merge: true,
            }
          );

        console.log(
          `SUCCESS: verifiedProfiles/${uid} created/updated.`
        );
      }

      await verificationRef.set(
        updateData,
        {
          merge: true,
        }
      );

      console.log(
        `SUCCESS: verificationRecords/${uid} updated to "${careConnectStatus}".`
      );

      return res
        .status(200)
        .send("Webhook processed");
    } catch (error) {
      console.error(
        "Didit webhook handler ERROR:",
        error
      );

      return res
        .status(500)
        .send("Webhook processing failed");
    }
  }
);


/*
 * Constant-time signature comparison.
 */
function safeCompare(a, b) {
  if (!a || !b) {
    return false;
  }

  const bufferA =
    Buffer.from(
      String(a),
      "utf8"
    );

  const bufferB =
    Buffer.from(
      String(b),
      "utf8"
    );

  if (
    bufferA.length !==
    bufferB.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    bufferA,
    bufferB
  );
}


/*
 * Export the actual Firebase function values.
 */
module.exports = {
  createIdentityVerification,
  diditWebhookV2,
};