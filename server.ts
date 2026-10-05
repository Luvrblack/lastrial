import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { INITIAL_PRODUCTS } from './src/data/initialProducts.js';
import { Product, Transaction } from './src/types/pos.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

// 1. Custom CORS Middleware for local network connected client devices
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// 2. Active client devices tracking state on local network
const activeClients = new Set<string>();
app.use((req, res, next) => {
  const clientIP = req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '127.0.0.1';
  const cleanIP = clientIP.replace(/^.*:/, '');
  if (cleanIP && cleanIP !== '1' && cleanIP !== '127.0.0.1' && cleanIP !== 'localhost') {
    activeClients.add(cleanIP);
  }
  next();
});

// Local JSON File DB path
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'pos_database.json');

// Ensure DB exists
function initDatabase() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DB_FILE)) {
    const initialData = {
      products: INITIAL_PRODUCTS,
      transactions: [] as Transaction[],
      lastInvoiceSeq: 1,
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

initDatabase();

function readDb() {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading DB, re-initializing:', err);
    initDatabase();
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  }
}

function writeDb(data: any) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error writing DB:', err);
  }
}

// ---------------- REST API ROUTES ----------------

// GET /api/products
app.get('/api/products', (req: Request, res: Response) => {
  const db = readDb();
  const includeArchived = req.query.archived === 'true';
  const products = includeArchived
    ? db.products
    : db.products.filter((p: Product) => p.status !== 'archived');
  res.json({ success: true, data: products });
});

// POST /api/products - Create new product
app.post('/api/products', (req: Request, res: Response) => {
  const db = readDb();
  const newProduct: Product = {
    ...req.body,
    id: req.body.id || `PRD-${Date.now().toString().slice(-6)}`,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  db.products.unshift(newProduct);
  writeDb(db);
  res.json({ success: true, message: 'Produk berhasil ditambahkan', data: newProduct });
});

// PUT /api/products/:id - Edit product
app.put('/api/products/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const db = readDb();
  const index = db.products.findIndex((p: Product) => p.id === id);

  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Produk tidak ditemukan' });
  }

  db.products[index] = {
    ...db.products[index],
    ...req.body,
    updatedAt: new Date().toISOString(),
  };

  writeDb(db);
  res.json({ success: true, message: 'Produk berhasil diperbarui', data: db.products[index] });
});

// DELETE /api/products/:id - Soft delete (archive)
app.delete('/api/products/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const db = readDb();
  const index = db.products.findIndex((p: Product) => p.id === id);

  if (index === -1) {
    return res.status(404).json({ success: false, message: 'Produk tidak ditemukan' });
  }

  // Soft Delete / Archive
  db.products[index].status = 'archived';
  db.products[index].updatedAt = new Date().toISOString();

  writeDb(db);
  res.json({ success: true, message: 'Produk berhasil diarsipkan (soft delete)' });
});

// POST /api/products/refresh - Reset/Refresh data from base seed or file
app.post('/api/products/refresh', (req: Request, res: Response) => {
  const db = readDb();
  // Ensure all active products stock & prices are re-synced if requested or return updated DB
  res.json({ success: true, message: 'Data berhasil diperbarui', data: db.products.filter((p: Product) => p.status !== 'archived') });
});

// POST /api/transactions - Save transaction and update stock
app.post('/api/transactions', (req: Request, res: Response) => {
  const db = readDb();
  const { items, subtotal, discount, tax, grandTotal, paymentMethod, amountPaid, change, cashierName, cashierId } = req.body;

  if (!items || !items.length) {
    return res.status(400).json({ success: false, message: 'Keranjang kosong' });
  }

  // Generate Invoice Number: INV-YYYYMMDD-XXXX
  const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seq = (db.lastInvoiceSeq || 1).toString().padStart(4, '0');
  const invoiceNumber = `INV-${todayStr}-${seq}`;
  db.lastInvoiceSeq = (db.lastInvoiceSeq || 1) + 1;

  // Deduct Stock atomically
  const stockErrors: string[] = [];
  items.forEach((item: any) => {
    const product = db.products.find((p: Product) => p.id === item.productId);
    if (!product) {
      stockErrors.push(`Produk ID ${item.productId} tidak ditemukan`);
    } else if (product.stock < item.quantity) {
      stockErrors.push(`Stok ${product.name} tidak mencukupi (Tersisa: ${product.stock})`);
    }
  });

  if (stockErrors.length > 0) {
    return res.status(400).json({ success: false, message: stockErrors.join(', ') });
  }

  // Perform stock reduction
  items.forEach((item: any) => {
    const product = db.products.find((p: Product) => p.id === item.productId);
    if (product) {
      product.stock -= item.quantity;
      product.updatedAt = new Date().toISOString();
    }
  });

  const transaction: Transaction = {
    transactionId: `TXN-${Date.now()}`,
    invoiceNumber,
    cashierId: cashierId || 'CSH-001',
    cashierName: cashierName || 'Budi Santoso',
    items,
    subtotal,
    discount: discount || 0,
    tax: tax || 0,
    grandTotal,
    paymentMethod,
    amountPaid,
    change,
    paymentStatus: 'SUCCESS',
    createdAt: new Date().toISOString(),
  };

  db.transactions.unshift(transaction);
  writeDb(db);

  res.json({
    success: true,
    message: 'Transaksi berhasil disimpan',
    data: transaction,
  });
});

// GET /api/transactions - Get transaction history
app.get('/api/transactions', (req: Request, res: Response) => {
  const db = readDb();
  res.json({ success: true, data: db.transactions || [] });
});

// GET /api/network-status - Detect local IPv4 LAN address and server metrics
app.get('/api/network-status', (req: Request, res: Response) => {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];

  for (const devName in interfaces) {
    const iface = interfaces[devName];
    if (!iface) continue;
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && !alias.internal) {
        ips.push(alias.address);
      }
    }
  }

  const primaryIp = ips[0] || '127.0.0.1';

  res.json({
    success: true,
    ips: ips.length > 0 ? ips : ['127.0.0.1'],
    primaryIp,
    port: PORT,
    dbStatus: '🟢 TERHUBUNG (pos_database.json)',
    apiStatus: '🟢 AKTIF',
    serverTime: new Date().toISOString(),
    clientCount: activeClients.size > 0 ? activeClients.size : 1,
    networkName: ips.length > 0 ? 'Wi-Fi / LAN Lokal (Aktif)' : 'Lokalhost (Offline)',
  });
});

// Start server function
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, port: Number(PORT) },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`🚀 TOKO POS Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
