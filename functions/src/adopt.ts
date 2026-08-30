import { onRequest } from "firebase-functions/v2/https";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { requireAppCheck } from "./appCheck";
import { requireUser } from "./auth";
import { decideCarry } from "./quota";

/**
 * Takes over the balance left on a guest identity.
 *
 * Somebody who used the app without an account and then signed into a Google
 * account that already existed cannot be linked to it -- the Google account is
 * already an identity of its own -- so Firebase signs them in and leaves the
 * guest uid behind, holding credits nobody can ever reach again. This is how
 * they get them back.
 *
 * Both sides have to prove who they are. The caller's own token says where the
 * credits are going; the guest's token, minted before the switch and still
 * valid for the hour, says where they are coming from. Naming a uid in the
 * body would let anyone drain anyone.
 */

const ACCOUNTS = "accounts";

interface AccountDocument {
  credits?: number;
  purchased?: number;
  /** Set once this guest's balance has been taken over. */
  carriedTo?: string;
}

export const adoptGuestCredits = onRequest(
  {
    region: "europe-west1",
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 10,
  },
  async (request, response) => {
    if (request.method !== "POST") {
      return void response.status(405).json({ error: "Use POST" });
    }
    if (!(await requireAppCheck(request, response))) {
      return;
    }
    const identity = await requireUser(request, response);
    if (!identity) {
      return;
    }
    // A guest adopting a guest is two anonymous installs, which is the shape
    // the free grant would be farmed through.
    if (identity.isAnonymous) {
      return void response.status(403).json({ error: "Sign in first", code: "NOT_SIGNED_IN" });
    }

    const guestToken = (request.body as { guestToken?: unknown } | null)?.guestToken;
    if (typeof guestToken !== "string" || guestToken.length === 0) {
      return void response.status(400).json({ error: "Which guest?", code: "INVALID" });
    }

    let guestUid: string;
    try {
      const decoded = await getAuth().verifyIdToken(guestToken);
      if (decoded.firebase?.sign_in_provider !== "anonymous") {
        return void response.status(400).json({ error: "That is not a guest", code: "INVALID" });
      }
      guestUid = decoded.uid;
    } catch {
      return void response.status(401).json({ error: "Invalid guest token", code: "UNAUTHENTICATED" });
    }

    // Linking keeps the uid, so the two being equal means there was nothing to
    // carry: the credits are already where they belong.
    if (guestUid === identity.uid) {
      return void response.status(200).json({ credits: null, moved: false });
    }

    try {
      const result = await carry(identity.uid, guestUid);
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json(result);
    } catch (error) {
      console.error("Could not carry the guest balance", error);
      response.status(503).json({ error: "Ledger unavailable", code: "LEDGER_UNAVAILABLE" });
    }
  },
);

async function carry(uid: string, guestUid: string): Promise<{ credits: number; moved: boolean }> {
  const db = getFirestore();
  const accountRef = db.collection(ACCOUNTS).doc(uid);
  const guestRef = db.collection(ACCOUNTS).doc(guestUid);

  return db.runTransaction(async (transaction) => {
    const [account, guest] = await transaction.getAll(accountRef, guestRef);
    const guestData = (guest.data() ?? {}) as AccountDocument;

    // Emptied on the way out, so a second call carries nothing. Without this
    // the same balance could be walked from account to account.
    if (!guest.exists || guestData.carriedTo) {
      const held = ((account.data() ?? {}) as AccountDocument).credits ?? 0;
      return { credits: account.exists ? held : 0, moved: false };
    }

    const accountData = (account.data() ?? {}) as AccountDocument;
    const decision = decideCarry({
      destination: {
        exists: account.exists,
        credits: accountData.credits ?? 0,
        inFlightUntilMs: null,
      },
      destinationPurchased: accountData.purchased ?? 0,
      guestCredits: guestData.credits ?? 0,
      guestPurchased: guestData.purchased ?? 0,
    });

    transaction.set(
      accountRef,
      {
        credits: decision.credits,
        purchased: decision.purchased,
        updatedAt: FieldValue.serverTimestamp(),
        ...(account.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      },
      { merge: true },
    );
    transaction.set(
      guestRef,
      { credits: 0, purchased: 0, carriedTo: uid, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

    console.log(`Carried ${decision.credits} credits from guest ${guestUid} to ${uid}`);
    return { credits: decision.credits, moved: decision.moved };
  });
}
