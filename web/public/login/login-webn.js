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

export async function registerWebn(event) {
    event.preventDefault();
    document.getElementById('res').innerText = "";
    const username = document.getElementById("username").value;
    if (!username) return;
    // const username = 'lalalainput'

    const options = {};
    options.publicKey = await (await fetch("/register/start", {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username })
    })).json();

    options.publicKey.challenge = base64URLToBuffer(options.publicKey.challenge);
    options.publicKey.user.id = base64URLToBuffer(options.publicKey.user.id);
    options.publicKey.excludeCredentials.forEach(cred => cred.id = base64URLToBuffer(cred.id));
    console.log(options)

    navigator.credentials.create(options)
        .then(async function (credential) {
            if (credential !== null) {
                console.log(credential);
                // convert credential to json serializeable
                const serializeable = {
                    authenticatorAttachment: credential.authenticatorAttachment,
                    id: credential.id,
                    rawId: bufferToBase64Url(credential.rawId),
                    response: {
                        attestationObject: bufferToBase64Url(credential.response.attestationObject),
                        clientDataJSON: bufferToBase64Url(credential.response.clientDataJSON)
                    },
                    type: credential.type
                };

                const ret = { data: serializeable, username }

                const response = await fetch('/register/finish',
                    {
                        method: "POST",
                        // mode: "cors", // no-cors, *cors, same-origin
                        cache: "no-cache", // *default, no-cache, reload, force-cache, only-if-cached
                        credentials: "same-origin", // include, *same-origin, omit
                        headers: {
                            "Content-Type": "application/json",
                            // 'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        // redirect: "follow", // manual, *follow, error
                        // referrerPolicy: "no-referrer", // no-referrer, *no-referrer-when-downgrade, origin, origin-when-cross-origin, same-origin, strict-origin, strict-origin-when-cross-origin, unsafe-url
                        body: JSON.stringify(ret), // body data type must match "Content-Type" header
                    });

                console.log(await response.json()); // parses JSON response into native JavaScript objects
                alert(`User ${username} registered`);

            }
        }).catch(function (err) {
            console.log(err);
            // No acceptable authenticator or user refused consent
        });
}

export async function loginWebn(event, username) {
    const options = {};

    const res = await fetch("/login/start", {
        method: 'POST',
        headers: { "Content-Type": "application/json" },
        body: username ? JSON.stringify({ username }) : null
    });
    if (res.status === 404) {
        document.getElementById('res').innerText = `User ${username} not found`;

        return;
    }

    const resObj = await res.json();
    const reqId = resObj.reqId;

    options.publicKey = resObj.publicKey;
    options.publicKey.challenge = base64URLToBuffer(options.publicKey.challenge);
    // options.publicKey.user.id = base64URLToBuffer(options.publicKey.user.id);
    options.publicKey.allowCredentials?.forEach(cred => cred.id = base64URLToBuffer(cred.id));

    if (!username) {
        // options.mediation = 'conditional'
    }

    const abortController = new AbortController();
    options.signal = abortController.signal;

    // setTimeout(() => {
    //     abortController.abort('too long');
    //     alert('aborted')
    // }, 5000);

    if (window.PublicKeyCredential &&
        PublicKeyCredential.isConditionalMediationAvailable) {
        // Check if conditional mediation is available.
        const isCMA = await PublicKeyCredential.isConditionalMediationAvailable();
        if (isCMA) {
            // Call WebAuthn authentication
            options.publicKey.userVerification = 'required'
            console.log('options', options)

            navigator.credentials.get(options)
                .then(async function (credential) {
                    alert('hmh')
                    console.log("credential", credential);
                    // Send authentication status to server

                    const serializeable = {
                        authenticatorAttachment: credential.authenticatorAttachment,
                        id: credential.id,
                        rawId: bufferToBase64Url(credential.rawId),
                        response: {
                            authenticatorData: bufferToBase64Url(credential.response.authenticatorData),
                            clientDataJSON: bufferToBase64Url(credential.response.clientDataJSON),
                            signature: bufferToBase64Url(credential.response.signature),
                            userHandle: bufferToBase64Url(credential.response.userHandle),
                        },
                        type: credential.type
                    };

                    const ret = { data: serializeable, reqId }

                    const response = await fetch('/login/finish',
                        {
                            method: "POST",
                            // mode: "cors", // no-cors, *cors, same-origin
                            cache: "no-cache", // *default, no-cache, reload, force-cache, only-if-cached
                            credentials: "same-origin", // include, *same-origin, omit
                            headers: {
                                "Content-Type": "application/json",
                                // 'Content-Type': 'application/x-www-form-urlencoded',
                            },
                            // redirect: "follow", // manual, *follow, error
                            // referrerPolicy: "no-referrer", // no-referrer, *no-referrer-when-downgrade, origin, origin-when-cross-origin, same-origin, strict-origin, strict-origin-when-cross-origin, unsafe-url
                            body: JSON.stringify(ret), // body data type must match "Content-Type" header
                        });

                    window.location.href = '/dashboard';

                    // const res = await response.json()
                    // console.log(res); // parses JSON response into native JavaScript objects
                    // document.getElementById('res').innerText = JSON.stringify(res.status, null, 2);

                }).catch(function (err) {
                    console.error(err);
                    document.getElementById('res').innerText = err;

                    // No acceptable passkey or user refused consent
                }).finally(() => {
                    alert('finally')
                });
        }
    }
}

export function loginWebnUsername(event) {
    document.getElementById('res').innerText = "";
    const username = document.getElementById("username").value;
    loginWebn(event, username);
}