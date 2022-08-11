export default class Auth {
    msalInstance;

    async login() {
        const configJson = await (await fetch("/config.json")).text();
        const config = JSON.parse(configJson);
        const msalInstance = new msal.PublicClientApplication(config.msalConfig);

        //Check if redirect
        const redirectResponse = await msalInstance.handleRedirectPromise();
        if (redirectResponse !== null) {
            // Acquire token silent success
            console.log("Token received from redirect");
            var newurl = window.location.protocol + "//" + window.location.host + window.location.pathname;
            window.history.pushState({ path: newurl }, '', newurl);
        }

        const accounts = msalInstance.getAllAccounts();

        if (accounts.length > 0) {
            this.msalInstance = msalInstance;
            const info = document.getElementById('info');

            const name = document.createElement('span');
            name.innerText = accounts[0].name;
            info.appendChild(name);

            /*
                        const aName = document.createElement('a');

                         aName.addEventListener('click', (event) => {
                             event.preventDefault();

                             // this.listUsers();
                             this.deleteUser();
             
                         });
             
                         aName.innerText = accounts[0].name;
                         aName.setAttribute('href', '')
                         info.appendChild(aName);
             */


        } else {
            console.log("Redirecting to login");
            msalInstance.loginRedirect();
        }
    }

    async getAccessToken() {
        const accounts = this.msalInstance.getAllAccounts();
        const request = {
            //scopes: ["openid"],
            scopes: ["bcb616b9-0f38-47ee-aeed-68dcffa68d67/openid"],
            // scopes: ["bcb616b9-0f38-47ee-aeed-68dcffa68d67/user_impersonation"],
        };

        if (accounts.length > 0) {
            try {
                request["account"] = accounts[0];
                const tokenResponse = await this.msalInstance.acquireTokenSilent(request);
                // store.commit("setAccessToken", tokenResponse.accessToken);
                // console.log("Token silent");
                return tokenResponse.accessToken;
            } catch (error) {
                console.error("Silent token acquisition failed. Using interactive mode: ", error);
            }
        }

        //Check if redirect
        const redirectResponse = await this.msalInstance.handleRedirectPromise();

        if (redirectResponse !== null) {
            console.log("Token received");
            // Acquire token silent success
            return redirectResponse.accessToken;
        }

        //Redirect
        console.log("Redirecting to sign in");
        await this.msalInstance.acquireTokenRedirect(request);
    }

    getRoles() {
        const accounts = this.msalInstance.getAllAccounts();
        return accounts[0].idTokenClaims?.roles ?? [];
    }

    getEmail() {
        const accounts = this.msalInstance.getAllAccounts();
        return accounts[0].username;
    }
}
