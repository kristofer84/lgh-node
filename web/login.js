
let msalInstance;

async function go() {
    await initMsal();
    const headers = new Headers({
        'Authorization': `Bearer ${await getAccessToken()}`
    });

    await fetch('/key', { headers: headers, method: 'GET' });
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

    const accounts = msalInstance.getAllAccounts();

    if (accounts.length === 0) {
        console.log("Redirecting to login");
        msalInstance.loginRedirect();
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

go();
