
let msalInstance;
let msalReady;

export async function loginMsal(event) {
    event.preventDefault();

    //A click before initMsal() finished used to throw on undefined
    await msalReady;

    const accounts = msalInstance.getAllAccounts();

    if (accounts.length === 0) {
        console.log("Redirecting to login");
        //Must return: the page is navigating away, and everything below
        //depends on having an account
        await msalInstance.loginRedirect();
        return;
    }

    const headers = new Headers({
        'Authorization': `Bearer ${await getAccessToken()}`
    });

    const res = await fetch('/key-msal', { headers: headers, method: 'GET' });
    if (!res.ok) {
        //403 means the account exists but has not been enabled yet
        const el = document.getElementById('res');
        if (el) el.innerText = res.status === 403
            ? 'This account is awaiting approval'
            : `Sign in failed (${res.status})`;
        return;
    }

    window.location.href = '/dashboard';
}

async function initMsal() {
    const configJson = await (await fetch("/config.json")).text();
    const config = JSON.parse(configJson);
    msalInstance = new msal.PublicClientApplication(config.msalConfig);

    //Check if redirect
    const redirectResponse = await msalInstance.handleRedirectPromise();
    if (redirectResponse !== null) {
        // Acquire token silent success
        console.log("Token received from redirect");
        var newurl = window.location.protocol + "//" + window.location.host + window.location.pathname;
        window.history.pushState({ path: newurl }, '', newurl);
    }
}

async function getAccessToken() {
    const accounts = msalInstance.getAllAccounts();
    const request = {
        scopes: ["openid", "email"],
    };

    if (accounts.length > 0) {
        try {
            request["account"] = accounts[0];
            const tokenResponse = await msalInstance.acquireTokenSilent(request);
            return tokenResponse.idToken;
        } catch (error) {
            console.error("Silent token acquisition failed. Using interactive mode: ", error);
        }
    }

    //Check if redirect
    const redirectResponse = await msalInstance.handleRedirectPromise();

    if (redirectResponse !== null) {
        console.log("Token received");
        // Acquire token silent success
        return redirectResponse.idToken;
    }

    //Redirect
    console.log("Redirecting to sign in");
    await msalInstance.acquireTokenRedirect(request);
}

msalReady = initMsal().catch(err => console.error('MSAL init failed', err));