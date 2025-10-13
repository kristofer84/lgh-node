import { validate, setCookie } from './user.js';

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

//TODO counter

import { promises as fs } from 'fs';
import {
    verifyRegistrationResponse,
    generateRegistrationOptions,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} from '@simplewebauthn/server';
const rpName = 'Home map';
const rpID = 'home.xcds.net';
const expectedOrigin = `https://${rpID}`;

function makeid(length) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    let counter = 0;
    while (counter < length) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
        counter += 1;
    }
    return result;
}

const allowNew = 1;
// console.log(makeid(5));

function getNewChallenge() {
    return makeid(200);
}

const dbFile = './webauthn.json';
const registrationOptions = new Map();
const authenticationOptions = new Map();

const binary = await fs.readFile(dbFile, 'binary');

const keyUserMap = {};
const users = JSON.parse(binary.toString());
for (const user of Object.entries(users)) {
    for (const key of user[1].keys) {
        key.registrationInfo.attestationObject = base64URLToBuffer(key.registrationInfo.attestationObject);
        key.registrationInfo.credentialPublicKey = base64URLToBuffer(key.registrationInfo.credentialPublicKey);
        keyUserMap[key.registrationInfo.credentialID] = [user[0]]
    }

}
// const users = {};

async function setUser(username, data) {
    const user = users[username];
    if (!user) {
        users[username] = { keys: [data] }
    }
    else {
        user.keys.push(data);
    }

    keyUserMap[data.registrationInfo.credentialID] = username;

    //Convert
    for (const user of Object.values(users)) {
        for (const key of user.keys) {
            key.registrationInfo.attestationObject = bufferToBase64Url(key.registrationInfo.attestationObject);
            key.registrationInfo.credentialPublicKey = bufferToBase64Url(key.registrationInfo.credentialPublicKey);
        }
    }
    let content = JSON.stringify(users, null, 2);

    //Reset
    for (const user of Object.values(users)) {
        for (const key of user.keys) {
            // console.log(key);
            key.registrationInfo.attestationObject = base64URLToBuffer(key.registrationInfo.attestationObject);
            key.registrationInfo.credentialPublicKey = base64URLToBuffer(key.registrationInfo.credentialPublicKey);
        }
    }

    await fs.writeFile(dbFile, content)
}

async function getOptions(user, userPasskeys) {
    // console.log(user, userPasskeys)
    const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userName: user.username,
        // userDisplayName: user.displayName,
        // Don't prompt users for additional information about the authenticator
        // (Recommended for smoother UX)
        attestationType: 'none',
        // Prevent users from re-registering existing authenticators
        excludeCredentials: userPasskeys.map(passkey => ({
            id: passkey.registrationInfo.credentialID,

            // Optional
            // transports: passkey.transports,
        })),
        // See "Guiding use of authenticators via authenticatorSelection" below
        authenticatorSelection: {
            // Defaults
            residentKey: 'preferred',
            userVerification: 'preferred',
            // Optional
            //authenticatorAttachment: 'cross-platform',
        },
    });
    return options;
}

export function registerWebnMethods(app) {

    // app.get('/challenge', async (req, res) => {

    //     res.header('content-type', 'application/json');
    //     res.end();
    // });
    if (allowNew)
        app.post('/register/start', async (req, res) => {
            // const username = 'lalalala'
            //If logged in, add from session
            const displayName = req.body.displayName;
            const username = req.body.username;
            const existing = users[username];

            const options = await getOptions({ username, displayName }, existing?.keys ?? []);
            registrationOptions[username] = options;
            res.json(options);
        });
    // app.post('/register/startold', (req, res) => {
    //     // const username = req.body.username;
    //     console.log(req.body)
    //     let challenge = getNewChallenge();
    //     challenges[req.body.username] = challenge;
    //     const pubKey = {
    //         challenge: challenge,
    //         rp: { id: rpID, name: 'Home Map' },
    //         // user: { id: req.body.id, name: username, displayName: req.body.displayName },
    //         pubKeyCredParams: [
    //             { type: 'public-key', alg: -7 }, //ES256
    //             { type: 'public-key', alg: -257 }, //RS256
    //         ],
    //         // authenticatorSelection: {
    //         //     authenticatorAttachment: 'platform',
    //         //     userVerification: 'required',
    //         //     residentKey: 'preferred',
    //         //     requireResidentKey: false,
    //         // }
    //     };
    //     res.json(pubKey);
    // })

    if (allowNew)
        app.post('/register/finish', async (req, res) => {
            const username = req.body.username;
            const options = registrationOptions[username];

            // Verify the attestation response
            let verification;
            try {
                verification = await verifyRegistrationResponse({
                    response: req.body.data,
                    expectedChallenge: options.challenge,
                    expectedOrigin,
                    expectedRPID: rpID
                });
            } catch (error) {
                console.error(error);
                return res.status(400).send({ error: error.message });
            }
            const { verified, registrationInfo } = verification;
            // console.log(verified)
            // console.log("registrationInfo", registrationInfo)
            if (verified) {
                setUser(username, { registrationInfo, options });
                return res.status(200).send(true);
            }
            res.status(500).send(false);
        });

    app.post('/login/start', async (req, res) => {
        let username = req.body.username;

        // let challenge = getNewChallenge();
        // challenges[username] = challenge;
        // res.json({
        const reqId = makeid(50);
        //     challenge,
        //     rpId,
        //     allowCredentials: [{
        //         type: 'public-key',
        //         id: users[username].credentialID,
        //         transports: ['internal'],
        //     }],
        //     userVerification: 'discouraged',
        // });
        const authReq = {
            rpID,

        };

        if (username) {
            const user = users[username];
            if (!user) {
                return res.status(404).send(false);
            }
            authReq["allowCredentials"] = user.keys.map(passkey => ({
                id: passkey.registrationInfo.credentialID,
                // transports: passkey.transports,
            }))
        }

        const options = await generateAuthenticationOptions(authReq);
        authenticationOptions[reqId] = options;
        console.log(options)
        const ret = { publicKey: options, reqId }
        res.json(ret);
    });

    app.post('/login/finish', async (req, res) => {
        // // let username = req.body.username;
        // if (username)
        //     console.log('Looking up key');
        // else {
        console.log('Looking up username from key');
        const keyId = req.body.data.id;
        const username = keyUserMap[keyId];
        const reqId = req.body.reqId;

        if (!username) {
            console.log(`KeyId ${keyId} not found`);
            return res.status(404).send(false);
        }
        if (!users[username]) {
            console.log(`User ${username} not found`);
            return res.status(404).send(false);
        }
        console.log(`${username} is trying to log in`)
        const options = authenticationOptions[reqId];
        console.log(options)

        let verification;

        try {
            const user = users[username];
            const authenticator = user.keys.find(s => s.registrationInfo.credentialID === req.body.data.id)?.registrationInfo;
            // console.log(authenticator)
            verification = await verifyAuthenticationResponse({
                expectedChallenge: options.challenge,
                response: req.body.data,
                authenticator,
                expectedRPID: rpID,
                expectedOrigin
            });

            //TODO save
            // authenticator.counter++;
        } catch (error) {
            console.error(error);
            return res.status(400).send({ error: error.message });
        }

        // console.log(verification);
        const { verified } = verification;
        if (verified) {
            const key = await validate(keyId, username);
            return setCookie(key, res);
            // return res.status(200).send(true);
        }
        return res.status(400).send(false);
    });

    console.log('Methods registered')
}

async function getAuthenticationOptions(username) {
    const user = users[username];
    // (Pseudocode) Retrieve any of the user's previously-
    // registered authenticators
    const userPasskeys = user.keys;

    const options = await generateAuthenticationOptions({
        rpID,
        // Require users to use a previously-registered authenticator
        allowCredentials: userPasskeys.map(passkey => ({
            id: passkey.registrationInfo.credentialID,
            // transports: passkey.transports,
        })),
    });

    // (Pseudocode) Remember this challenge for this user
    setCurrentAuthenticationOptions(user, options);

    return options;


}
