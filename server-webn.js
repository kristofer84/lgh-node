import { promises as fs } from 'fs';
//randomBytes rather than the global crypto.getRandomValues: globalThis.crypto
//is not enabled by default on Node 18, which is what runs this in production.
import { createHash, randomBytes, webcrypto } from 'crypto';
import {
    verifyRegistrationResponse,
    generateRegistrationOptions,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { validate, validateKey, setCookie } from './user.js';
import { log } from './log.js';

function base64URLToBuffer(base64URL) {
    const base64 = base64URL.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (base64.length % 4)) % 4;
    return Uint8Array.from(atob(base64.padEnd(base64.length + padLen, "=")), (c) => c.charCodeAt(0));
}

function bufferToBase64Url(buffer) {
    if (!buffer) return null;
    const bytes = new Uint8Array(buffer);
    let string = "";
    bytes.forEach((b) => (string += String.fromCharCode(b)));

    const base64 = btoa(string);
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

//@simplewebauthn/server resolves globalThis.crypto lazily, and Node 18 only
//exposes it behind --experimental-global-webcrypto. Without this every call
//fails with "An instance of the Crypto API could not be located", i.e. passkey
//login is broken outright on Node 18. Node >= 19 already has it.
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const rpName = 'Home map';
const rpID = 'home.xcds.net';
const expectedOrigin = `https://${rpID}`;

//Passkey identities live in their own keyspace in db/users.json so that every
//passkey belonging to one person maps to ONE user record. Previously each
//credential ID became its own record, so a person with two passkeys was two
//users and each had to be enabled separately.
const OID_PREFIX = 'webauthn:';
export function webauthnOid(username) {
    return OID_PREFIX + username;
}

//Registering a passkey for a username that already exists must be authenticated
//as that same user -- otherwise anyone could POST /register/finish for an
//existing username, get their credential appended to that user's key list, and
//log in as them.
const allowNewUsers = true;

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

//Express 4 does not catch rejections from async handlers; an uncaught one used
//to take the whole process down (mqtt-web.js exits on uncaughtException).
function wrap(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

//A Map keyed by a client-supplied string, with expiry. The previous code
//declared `new Map()` but used `map[key] = value` property syntax, so entries
//were plain properties that were never cleaned up.
class ExpiringStore {
    #entries = new Map();

    set(key, value) {
        this.#entries.set(key, { value, expires: Date.now() + CHALLENGE_TTL_MS });
        this.#sweep();
    }

    take(key) {
        if (typeof key !== 'string') return undefined;
        const entry = this.#entries.get(key);
        if (!entry) return undefined;
        //Single use: a challenge must never be replayable
        this.#entries.delete(key);
        if (entry.expires < Date.now()) return undefined;
        return entry.value;
    }

    #sweep() {
        const now = Date.now();
        for (const [k, v] of this.#entries) {
            if (v.expires < now) this.#entries.delete(k);
        }
    }
}

const dbFile = './webauthn.json';
const registrationOptions = new ExpiringStore();
const authenticationOptions = new ExpiringStore();

const binary = await fs.readFile(dbFile, 'binary');

//credentialID -> username. Always a string; it used to be an array here and a
//string in setUser(), and the array leaked into db/users.json.
const keyUserMap = {};
const users = JSON.parse(binary.toString());
for (const [username, user] of Object.entries(users)) {
    user.keys ??= [];
    for (const key of user.keys) {
        key.registrationInfo.attestationObject = base64URLToBuffer(key.registrationInfo.attestationObject);
        key.registrationInfo.credentialPublicKey = base64URLToBuffer(key.registrationInfo.credentialPublicKey);
        key.registrationInfo.counter ??= 0;
        keyUserMap[key.registrationInfo.credentialID] = username;
    }
}

//Serialize without mutating the live objects. The old setUser() encoded every
//user in place, wrote the file, then decoded them again -- so a throw between
//those two loops left every public key in memory as a string.
function serialize() {
    const out = {};
    for (const [username, user] of Object.entries(users)) {
        out[username] = {
            keys: user.keys.map(key => ({
                ...key,
                registrationInfo: {
                    ...key.registrationInfo,
                    attestationObject: bufferToBase64Url(key.registrationInfo.attestationObject),
                    credentialPublicKey: bufferToBase64Url(key.registrationInfo.credentialPublicKey),
                },
            })),
        };
    }
    return JSON.stringify(out, null, 2);
}

//Serialize writes so two concurrent logins cannot interleave and truncate the file
let writeChain = Promise.resolve();
function saveDb() {
    writeChain = writeChain.then(() => fs.writeFile(dbFile, serialize())).catch(err => log(`Failed to save ${dbFile}: ${err.message}`));
    return writeChain;
}

async function setUser(username, data) {
    const user = users[username];
    if (!user) {
        users[username] = { keys: [data] };
    }
    else {
        user.keys.push(data);
    }

    keyUserMap[data.registrationInfo.credentialID] = username;

    await saveDb();
}

//Stable per-username user handle, so re-registering does not create a second
//discoverable-credential entry in the authenticator for the same person.
function userIdFor(username) {
    return new Uint8Array(createHash('sha256').update(username).digest());
}

async function getOptions(user, userPasskeys) {
    const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userName: user.username,
        userID: userIdFor(user.username),
        // Don't prompt users for additional information about the authenticator
        // (Recommended for smoother UX)
        attestationType: 'none',
        // Prevent users from re-registering existing authenticators
        excludeCredentials: userPasskeys.map(passkey => ({
            id: passkey.registrationInfo.credentialID,
        })),
        authenticatorSelection: {
            residentKey: 'preferred',
            //verifyRegistrationResponse defaults to requireUserVerification: true,
            //so asking for 'preferred' here produced registrations the server
            //then refused. Keep the two ends in agreement.
            userVerification: 'required',
        },
    });
    return options;
}

//Who is the caller, according to the session cookie? Used to decide whether a
//passkey may be added to an already-existing username.
async function currentUser(req) {
    const key = req.signedCookies?.key;
    if (!key) return undefined;
    return await validateKey(key);
}

export function registerWebnMethods(app) {

    app.post('/register/start', wrap(async (req, res) => {
        const username = req.body?.username;
        const displayName = req.body?.displayName;
        if (typeof username !== 'string' || !username) {
            return res.status(400).send({ error: 'username required' });
        }

        //Object.hasOwn, not truthiness: users['constructor'] would otherwise
        //resolve through Object.prototype
        const existing = Object.hasOwn(users, username) ? users[username] : undefined;
        if (existing) {
            //Adding a passkey to an existing account requires being that account
            const caller = await currentUser(req);
            if (!caller || caller.preferred_username !== username) {
                log(`Rejected passkey registration for existing user ${username}: not authenticated as that user`);
                return res.status(403).send({ error: 'Sign in first to add another passkey' });
            }
        }
        else if (!allowNewUsers) {
            return res.status(403).send({ error: 'Registration is closed' });
        }

        const options = await getOptions({ username, displayName }, existing?.keys ?? []);
        registrationOptions.set(username, options);
        res.json(options);
    }));

    app.post('/register/finish', wrap(async (req, res) => {
        const username = req.body?.username;
        const data = req.body?.data;
        if (typeof username !== 'string' || !username || !data) {
            return res.status(400).send({ error: 'username and data required' });
        }

        const existing = Object.hasOwn(users, username) ? users[username] : undefined;
        if (existing) {
            const caller = await currentUser(req);
            if (!caller || caller.preferred_username !== username) {
                log(`Rejected passkey registration for existing user ${username}: not authenticated as that user`);
                return res.status(403).send({ error: 'Sign in first to add another passkey' });
            }
        }
        else if (!allowNewUsers) {
            return res.status(403).send({ error: 'Registration is closed' });
        }

        const options = registrationOptions.take(username);
        if (!options) {
            return res.status(400).send({ error: 'No pending registration, start again' });
        }

        let verification;
        try {
            verification = await verifyRegistrationResponse({
                response: data,
                expectedChallenge: options.challenge,
                expectedOrigin,
                expectedRPID: rpID
            });
        } catch (error) {
            log(`Registration verification failed for ${username}: ${error.message}`);
            return res.status(400).send({ error: error.message });
        }

        const { verified, registrationInfo } = verification;
        if (!verified) {
            return res.status(400).send({ error: 'Registration could not be verified' });
        }

        registrationInfo.counter ??= 0;
        await setUser(username, { registrationInfo, options });

        //Make sure the account exists in db/users.json so it can be enabled by
        //hand. New accounts are created disabled -- that is the access gate.
        const key = await validate(webauthnOid(username), username);
        log(`Passkey registered for ${username}${key ? '' : ' (account not enabled yet)'}`);
        return res.status(200).send({ ok: true, enabled: !!key });
    }));

    app.post('/login/start', wrap(async (req, res) => {
        const username = req.body?.username;

        const authReq = { rpID, userVerification: 'required' };

        if (username) {
            if (typeof username !== 'string') {
                return res.status(400).send({ error: 'invalid username' });
            }
            const user = Object.hasOwn(users, username) ? users[username] : undefined;
            if (!user) {
                return res.status(404).send({ error: 'User not found' });
            }
            authReq.allowCredentials = user.keys.map(passkey => ({
                id: passkey.registrationInfo.credentialID,
            }));
        }

        const options = await generateAuthenticationOptions(authReq);
        const reqId = randomBytes(32).toString('base64url');
        authenticationOptions.set(reqId, options);
        res.json({ publicKey: options, reqId });
    }));

    app.post('/login/finish', wrap(async (req, res) => {
        //Every one of these used to be an unguarded property read on req.body,
        //and a TypeError here exited the whole server.
        const data = req.body?.data;
        const reqId = req.body?.reqId;
        const keyId = data?.id;

        if (!data || typeof keyId !== 'string' || typeof reqId !== 'string') {
            return res.status(400).send({ error: 'data.id and reqId required' });
        }

        const username = keyUserMap[keyId];
        if (!username || !Object.hasOwn(users, username)) {
            log(`KeyId ${keyId} not recognised`);
            return res.status(401).send({ error: 'Unknown credential' });
        }

        const options = authenticationOptions.take(reqId);
        if (!options) {
            return res.status(400).send({ error: 'Login expired, try again' });
        }

        const user = users[username];
        const authenticator = user.keys.find(s => s.registrationInfo.credentialID === keyId)?.registrationInfo;
        if (!authenticator) {
            return res.status(401).send({ error: 'Unknown credential' });
        }

        let verification;
        try {
            verification = await verifyAuthenticationResponse({
                expectedChallenge: options.challenge,
                response: data,
                authenticator,
                expectedRPID: rpID,
                expectedOrigin
            });
        } catch (error) {
            log(`Authentication failed for ${username}: ${error.message}`);
            return res.status(401).send({ error: error.message });
        }

        const { verified, authenticationInfo } = verification;
        if (!verified) {
            return res.status(401).send({ error: 'Not verified' });
        }

        //Persist the signature counter -- without this, replay detection is inert
        if (typeof authenticationInfo?.newCounter === 'number') {
            authenticator.counter = authenticationInfo.newCounter;
            saveDb();
        }

        const key = await validate(webauthnOid(username), username);
        if (!key) {
            //Account exists but is not enabled. Say so, instead of returning a
            //204 with an 'undefined' cookie that 401s on the next request.
            log(`Passkey login refused: ${username} is not enabled`);
            return res.status(403).send({ error: 'Account is awaiting approval' });
        }

        log(`${username} logged in with passkey`);
        return setCookie(key, res);
    }));

    log('Webauthn methods registered');
}
