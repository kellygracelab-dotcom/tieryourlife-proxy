/**
 * The base data an e2e run may want, written through the emulators only:
 * the owner account `.env.demo-tieryourlife` names, the built-in sections
 * (which the proxy seeds itself on its first read of them) and one approved
 * topic. Run again, it changes nothing. Prints what it made as JSON.
 *
 *   npm run seed:e2e    (with `npm run emulators:e2e` running)
 */
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

export const PROJECT = "demo-tieryourlife";
export const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
export const FUNCTIONS = process.env.E2E_FUNCTIONS_URL ?? `http://127.0.0.1:5001/${PROJECT}/europe-west1`;

/** Test values for the demo project alone; the uid and address are the ones `.env.demo-tieryourlife` makes the owner. */
export const OWNER = { uid: "e2eOwner0001", email: "owner@e2e.test", password: "e2e-owner-password", displayName: "E2E Owner" };
export const TOPIC = { name: "Studio Ghibli", section: "anime" };

const local = (host: string) => /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host);

export function assertEmulatorsOnly(): void {
  const functions = new URL(FUNCTIONS);
  if (!local(AUTH_HOST) || !local(functions.host) || !functions.pathname.startsWith(`/${PROJECT}/`)) {
    throw new Error(`Refusing to touch anything but the ${PROJECT} emulators`);
  }
}

/** An Auth emulator call; the key is not checked there. */
export async function identity(method: string, body: object): Promise<{ idToken: string; localId: string }> {
  const reply = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:${method}?key=demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, returnSecureToken: true }),
  });
  if (!reply.ok) throw new Error(`Auth emulator ${method} answered ${reply.status}: ${await reply.text()}`);
  return (await reply.json()) as { idToken: string; localId: string };
}

/** A password update revokes the guest's old auth_time. Sign in afresh rather than use update.idToken. */
export async function passwordAccount(idToken: string, email: string): Promise<{ idToken: string; localId: string }> {
  const password = "e2e-password";
  await identity("update", { idToken, email, password });
  return identity("signInWithPassword", { email, password });
}

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

export async function call(token: string, method: string, path: string, body?: unknown): Promise<Answer> {
  const reply = await fetch(`${FUNCTIONS}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await reply.text();
  return { status: reply.status, body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

export async function ownerToken(): Promise<string> {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_HOST;
  const auth = getAuth(initializeApp({ projectId: PROJECT }, "seed-e2e"));
  await auth.getUser(OWNER.uid).catch(() => auth.createUser({ ...OWNER, emailVerified: true }));
  return (await identity("signInWithPassword", { email: OWNER.email, password: OWNER.password })).idToken;
}

export async function seed(): Promise<{ owner: { uid: string; email: string }; sections: string[]; topic: { id: string } & typeof TOPIC }> {
  assertEmulatorsOnly();
  const token = await ownerToken();
  const sections = await call(token, "GET", "/lists/sections");
  if (sections.status !== 200 || sections.body.role !== "owner") {
    throw new Error(`The owner was not recognised (${sections.status}): is .env.demo-tieryourlife loaded?`);
  }
  const topic = await call(token, "POST", "/lists/topics", TOPIC);
  const topicId = topic.status === 201 ? topic.body.id : topic.body.code === "NAME_TAKEN" ? topic.body.id : null;
  if (typeof topicId !== "string") throw new Error(`Could not make the topic (${topic.status}): ${JSON.stringify(topic.body)}`);
  return {
    owner: { uid: OWNER.uid, email: OWNER.email },
    sections: (sections.body.sections as { id: string }[]).map((one) => one.id),
    topic: { id: topicId, ...TOPIC },
  };
}

if (require.main === module) {
  seed().then(
    (made) => console.log(JSON.stringify(made, null, 2)),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
