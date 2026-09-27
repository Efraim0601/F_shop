const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const app = createApp();

app.listen(port, process.env.HOST || '0.0.0.0', () => {
  console.log(`F-Shop démarré sur http://localhost:${port}`);
});
