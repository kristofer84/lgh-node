const http = require('http')
const fs = require('fs')
const path = require('path');

const server = http.createServer((req, res) => {
	var { url } = req;

	if (url.split('/')[1] === 'toggle') {
		res.statusCode = 204;

		res.end();
		return;
	}

	if (url.endsWith('jpg')) {
		var filePath = path.join('.', url);
		var stat = fs.statSync(filePath);

		res.writeHead(200, {
			'Content-Type': 'image/jpeg',
			'Content-Length': stat.size
		});

		var readStream = fs.createReadStream(filePath);
		// We replaced all the event handlers with a simple call to readStream.pipe()
		readStream.pipe(res);

		return;
	}

	res.statusCode = 200;
	var html = getFile('./dev.html');
	res.end(html);
});


function getFile(file) {
	var f = fs.readFileSync(file, 'utf8');
	return f;
}

server.listen(8080, () => {
	console.log(`Server running`);
});