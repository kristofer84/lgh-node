import webpush from 'web-push';

//Secrets live in .env (gitignored), never in this file.
//Read lazily: ESM hoists imports, so this module is evaluated before the
//entry point's loadEnv() call has had a chance to run.
function getVapidDetails() {
    const details = {
        publicKey: process.env.VAPID_PUBLIC_KEY,
        privateKey: process.env.VAPID_PRIVATE_KEY,
        subject: process.env.VAPID_SUBJECT
    };
    if (!details.publicKey || !details.privateKey || !details.subject) return undefined;
    return details;
}

export function sendNotifications(users) {
    const vapidDetails = getVapidDetails();
    if (!vapidDetails) {
        console.log('Push disabled: VAPID_* missing from .env');
        return;
    }

    // Create the notification content.
    const notification = JSON.stringify({
        title: "Hello, Notifications!",
        options: {
            body: `Hello from map`,
            badge: '/favicon-192.png', //masked
            //            icon: '/favicon-192.png',
            icon: '/images/sync-alt-solid.svg', // bild till h
            image: '/sk.jpeg',
            tag: 'replaceMe'
        }
    });
    // Customize how the push service should attempt to deliver the push message.
    // And provide authentication information.
    const options = {
        TTL: 10000,
        vapidDetails: vapidDetails
    };

    for (const subscriptions of users) {
        // Send a push message to each client specified in the subscriptions array.
        subscriptions.forEach(subscription => {
            const endpoint = subscription.endpoint;
            const id = endpoint.substr((endpoint.length - 8), endpoint.length);
            webpush.sendNotification(subscription, notification, options)
                .then(result => {
                    console.log(`Endpoint ID: ${id}`);
                    console.log(`Result: ${result.statusCode}`);
                })
                .catch(error => {
                    console.log(`Endpoint ID: ${id}`);
                    console.log(`Error: ${error} `);
                    console.log(JSON.stringify(error, null, 2));
                });
        });
    }
}
