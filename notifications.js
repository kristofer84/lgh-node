import webpush from 'web-push';
const vapidDetails = {
    publicKey: 'BF48UEbLK-xWlzN4CIqFBvbwErKCzne1J2qZyCcH5UDwyDBM9ibMwkPwXk9dhJeFz4VnvhIbhKHB55iw8Oa-Qlk',
    privateKey: 'WRrqxsopvmZ_asI7X5QKMabOxdviCeHctddbK1IzMEE',
    subject: 'mailto:webpush@xcds.net'
};

export function sendNotifications(users) {

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
