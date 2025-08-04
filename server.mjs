import { createServer } from 'http';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

var app = express();
var server = createServer(app);
server.listen(process.env.PORT || 3000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/js', express.static(path.join(__dirname, 'public/js')));
app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use('/src', express.static(path.join(__dirname, 'public/src')));
app.use('/html', express.static(path.join(__dirname, 'public/html')));
app.use('/img', express.static(path.join(__dirname, 'public/img')));
app.use('/audio', express.static(path.join(__dirname, 'public/audio')));
app.use('/json', express.static(path.join(__dirname, 'public/json')));
app.use('/temp_folder', express.static(path.join(__dirname, 'public/temp_folder')));
app.use('/', express.static(path.join(__dirname, '/index.html')));

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname + '/index.html'));
});