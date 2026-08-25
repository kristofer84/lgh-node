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

function showMessage(text) {
    document.getElementById('res').innerText = text;
}

//The server answers errors as {error: "..."}; surface that rather than
//"[object Object]"
async function errorText(response, fallback) {
    try {
        const body = await response.json();
        if (body?.error) return body.error;
    } catch {
        //no JSON body
    }
    return fallback;
}

const postJson = (url, body) => fetch(url, {
    method: 'POST',
    cache: 'no-cache',
    credentials: 'same-origin',
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {})
});

export async function registerWebn(event) {
    event.preventDefault();
    showMessage("");

    const username = document.getElementById("username").value.trim();
    if (!username) {
        showMessage('Enter a username first');
        return;
    }

    try {
        const startRes = await postJson('/register/start', { username });
        if (!startRes.ok) {
            showMessage(await errorText(startRes, `Could not start registration (${startRes.status})`));
            return;
        }

        const options = { publicKey: await startRes.json() };
        options.publicKey.challenge = base64URLToBuffer(options.publicKey.challenge);
        options.publicKey.user.id = base64URLToBuffer(options.publicKey.user.id);
        //excludeCredentials is absent for a brand new user
        options.publicKey.excludeCredentials?.forEach(cred => cred.id = base64URLToBuffer(cred.id));

        const credential = await navigator.credentials.create(options);
        if (!credential) {
            showMessage('No credential was created');
            return;
        }

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

        const finishRes = await postJson('/register/finish', { data: serializeable, username });
        if (!finishRes.ok) {
            showMessage(await errorText(finishRes, `Registration failed (${finishRes.status})`));
            return;
        }

        const result = await finishRes.json();
        showMessage(result.enabled
            ? `Passkey registered for ${username}. You can sign in now.`
            : `Passkey registered for ${username}, but the account still needs to be enabled.`);
    } catch (err) {
        //Includes the user cancelling the prompt
        console.error(err);
        showMessage(err?.message ?? 'Registration failed');
    }
}

export async function loginWebn(event, username) {
    event?.preventDefault();
    showMessage("");

    if (!window.PublicKeyCredential) {
        showMessage('This browser does not support passkeys');
        return;
    }

    try {
        const startRes = await postJson('/login/start', username ? { username } : {});
        if (startRes.status === 404) {
            showMessage(`User ${username} not found`);
            return;
        }
        if (!startRes.ok) {
            showMessage(await errorText(startRes, `Could not start sign in (${startRes.status})`));
            return;
        }

        const { publicKey, reqId } = await startRes.json();

        const options = { publicKey };
        options.publicKey.challenge = base64URLToBuffer(options.publicKey.challenge);
        options.publicKey.allowCredentials?.forEach(cred => cred.id = base64URLToBuffer(cred.id));

        //This whole block used to sit inside an isConditionalMediationAvailable()
        //check, so on any browser without conditional mediation the button did
        //nothing at all -- no request, no error.
        const credential = await navigator.credentials.get(options);
        if (!credential) {
            showMessage('No passkey was selected');
            return;
        }

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

        const finishRes = await postJson('/login/finish', { data: serializeable, reqId });

        //Previously this redirected unconditionally, so a rejected login looked
        //exactly like a successful one and then bounced back from /dashboard.
        if (!finishRes.ok) {
            showMessage(await errorText(finishRes, `Sign in failed (${finishRes.status})`));
            return;
        }

        window.location.href = '/dashboard';
    } catch (err) {
        console.error(err);
        showMessage(err?.message ?? 'Sign in failed');
    }
}

export function loginWebnUsername(event) {
    const username = document.getElementById("username").value.trim();
    if (!username) {
        showMessage('Enter a username first');
        return;
    }
    loginWebn(event, username);
}
