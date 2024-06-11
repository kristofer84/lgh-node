self.addEventListener('push', (event) => {
   let notification = event.data.json();

//     const notification = {
// 		title: "Hello, Notifications?",
// 		options: {
//             body: `Hello no`,
// 			icon: '/favicon-192.png',
//             //masked
// //            icon: '/favicon-192.png',
//             badge: '/images/sync-alt-solid.svg',
// 			image: '/sk.jpeg',
// 			tag: 'replaceMe'
//         }
//     };
    // Customize how the push

    self.registration.showNotification(
        notification.title,
        notification.options
    );
});

self.addEventListener('notificationclick', (event) => { const 
  clickedNotification = event.notification; 
  clickedNotification.close();
  // Do something as the result of the notification click
  //const promiseChain = doSomething(); event.waitUntil(promiseChain);
});

    // Create the notification content.
