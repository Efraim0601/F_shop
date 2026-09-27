const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const app = createApp(process.env.DB_FILE ? { dbFile: process.env.DB_FILE } : undefined);

app.listen(port, () => {
  console.log(`F-Shop démarré sur http://localhost:${port}`);
});
