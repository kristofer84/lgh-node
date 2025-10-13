import { loginMsal } from './login-msal.js';
import { registerWebn, loginWebn, loginWebnUsername } from './login-webn.js'

document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("loginMsal").onclick = loginMsal;
    document.getElementById("loginWebn").onclick = loginWebn;
    document.getElementById("loginWebnUser").onclick = loginWebnUsername;
    document.getElementById("register").onclick = registerWebn;

});
