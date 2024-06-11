if (navigator.serviceWorker) {
	// Register a service worker hosted at the root of the site using 
	// the default scope.
	navigator.serviceWorker.register("/scripts/sw.js").then((registration) => {
		console.log("Service worker registration succeeded:", registration);

		const applicationServerKey = 'BF48UEbLK-xWlzN4CIqFBvbwErKCzne1J2qZyCcH5UDwyDBM9ibMwkPwXk9dhJeFz4VnvhIbhKHB55iw8Oa-Qlk';

		const options = {
			userVisibleOnly: true,
			applicationServerKey,
		};

		const btn = document.getElementById('subscribe')
		btn.addEventListener("click", () => {
			alert('click')
			registration.pushManager.subscribe(options).then(async (pushSubscription) => {
				console.log(pushSubscription);
				await postSubscription(pushSubscription);
				// The push subscription details needed by the application 
				// server are now available, and can be sent to it using, for 
				// example, an XMLHttpRequest.
			},
				(error) => {
					// During development it often helps to log errors to the 
					// console. In a production environment it might make sense to 
					// also report information about errors back to the application 
					// server.
					console.error(error);
				});
		});
	},
		(error) => {
			console.log(`Service worker registration failed: 
      ${error}`);
		});
} else {
	console.log("Service workers are not supported.");
}

async function postSubscription(subscription) {
	const url = '/subscribe';
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", },
		body: JSON.stringify(subscription),
	});
	return response.json();
}