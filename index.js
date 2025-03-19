// // index.js
// const express = require('express');
// const bodyParser = require('body-parser');
// const indiaRoutes = require('./routes/india');
// const usaRoutes = require('./routes/usa');
// const complianceRoutes = require('./routes/compliance');

// const app = express();
// const PORT = 3000;

// app.use(bodyParser.json());
// app.use('/india', indiaRoutes);
// app.use('/usa', usaRoutes);
// app.use('/api', complianceRoutes);

// app.get('/', (req, res) => {
//   res.send('Export Compliance API is running!');
// });

// app.listen(PORT, () => {
//   console.log(`Server is running on http://localhost:${PORT}`);
// });

// index.js
const express = require('express');
const bodyParser = require('body-parser');
const indiaRoutes = require('./routes/india');
const usaRoutes = require('./routes/usa');
const complianceRoutes = require('./routes/compliance');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({extended: true, limit: '50mb'}));

// Add CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Routes
app.use('/india', indiaRoutes);
app.use('/usa', usaRoutes);
app.use('/api', complianceRoutes);

// Root route
app.get('/', (req, res) => {
  res.send('Export-Import Compliance API is running!');
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    status: false,
    error: 'Internal Server Error',
    message: err.message
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});