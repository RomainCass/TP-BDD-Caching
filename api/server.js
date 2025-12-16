const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');

const app = express();
app.use(express.json());

// Configuration des pools de connexion PostgreSQL
const primaryPool = new Pool({
  host: process.env.DB_PRIMARY_HOST || 'haproxy',
  port: process.env.DB_PRIMARY_PORT || 5432,
  user: process.env.DB_USER || 'app',
  password: process.env.DB_PASSWORD || 'app_pwd',
  database: process.env.DB_NAME || 'appdb',
});

const replicaPool = new Pool({
  host: process.env.DB_REPLICA_HOST || 'db-replica',
  port: process.env.DB_REPLICA_PORT || 5432,
  user: process.env.DB_USER || 'app',
  password: process.env.DB_PASSWORD || 'app_pwd',
  database: process.env.DB_NAME || 'appdb',
});

// Configuration Redis
let redisClient;
let redisAvailable = true;

(async () => {
  try {
    redisClient = redis.createClient({
      socket: {
        host: process.env.REDIS_HOST || 'redis',
        port: process.env.REDIS_PORT || 6379,
      }
    });

    redisClient.on('error', (err) => {
      console.error('Redis Error:', err);
      redisAvailable = false;
    });

    redisClient.on('connect', () => {
      console.log('✅ Connected to Redis');
      redisAvailable = true;
    });

    await redisClient.connect();
  } catch (err) {
    console.error('❌ Redis connection failed:', err);
    redisAvailable = false;
  }
})();

// Middleware pour vérifier la santé des services
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      redis: redisAvailable ? 'up' : 'down',
      database: 'checking...'
    }
  };

  try {
    await primaryPool.query('SELECT 1');
    health.services.database = 'up';
  } catch (err) {
    health.services.database = 'down';
    health.status = 'degraded';
  }

  res.json(health);
});

// GET /products - Lire tous les produits (depuis la replica)
app.get('/products', async (req, res) => {
  try {
    const result = await replicaPool.query(
      'SELECT * FROM products ORDER BY id'
    );
    res.json({
      success: true,
      source: 'replica',
      count: result.rows.length,
      data: result.rows
    });
  } catch (err) {
    console.error('Error fetching products:', err);
    // Fallback vers primary si replica échoue
    try {
      const result = await primaryPool.query(
        'SELECT * FROM products ORDER BY id'
      );
      res.json({
        success: true,
        source: 'primary (fallback)',
        count: result.rows.length,
        data: result.rows
      });
    } catch (fallbackErr) {
      res.status(500).json({ 
        success: false, 
        error: 'Database error',
        details: fallbackErr.message 
      });
    }
  }
});

// GET /products/:id - Lire un produit avec cache Redis
app.get('/products/:id', async (req, res) => {
  const productId = parseInt(req.params.id);
  const cacheKey = `product:${productId}`;
  
  try {
    // 1. Tenter de lire depuis Redis
    if (redisAvailable) {
      try {
        const cachedProduct = await redisClient.get(cacheKey);
        if (cachedProduct) {
          return res.json({
            success: true,
            source: 'cache',
            data: JSON.parse(cachedProduct),
            cached_at: new Date().toISOString()
          });
        }
      } catch (cacheErr) {
        console.warn('Cache read error:', cacheErr);
      }
    }

    // 2. Cache miss → lire depuis replica
    const result = await replicaPool.query(
      'SELECT * FROM products WHERE id = $1',
      [productId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Product not found' 
      });
    }

    const product = result.rows[0];

    // 3. Mettre en cache avec TTL de 60 secondes
    if (redisAvailable) {
      try {
        await redisClient.setEx(cacheKey, 60, JSON.stringify(product));
      } catch (cacheErr) {
        console.warn('Cache write error:', cacheErr);
      }
    }

    res.json({
      success: true,
      source: 'replica',
      data: product
    });

  } catch (err) {
    console.error('Error fetching product:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Database error',
      details: err.message 
    });
  }
});

// POST /products - Créer un produit (écriture sur primary)
app.post('/products', async (req, res) => {
  const { name, price_cents } = req.body;

  if (!name || !price_cents) {
    return res.status(400).json({ 
      success: false, 
      error: 'name and price_cents are required' 
    });
  }

  try {
    const result = await primaryPool.query(
      'INSERT INTO products(name, price_cents) VALUES($1, $2) RETURNING *',
      [name, price_cents]
    );

    res.status(201).json({
      success: true,
      source: 'primary',
      data: result.rows[0]
    });
  } catch (err) {
    console.error('Error creating product:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Database error',
      details: err.message 
    });
  }
});

// PUT /products/:id - Mettre à jour un produit (écriture + invalidation cache)
app.put('/products/:id', async (req, res) => {
  const productId = parseInt(req.params.id);
  const { name, price_cents } = req.body;

  if (!name && !price_cents) {
    return res.status(400).json({ 
      success: false, 
      error: 'name or price_cents required' 
    });
  }

  try {
    // Construction de la requête dynamique
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (price_cents) {
      updates.push(`price_cents = $${paramIndex++}`);
      values.push(price_cents);
    }
    
    updates.push(`updated_at = NOW()`);
    values.push(productId);

    const query = `
      UPDATE products 
      SET ${updates.join(', ')} 
      WHERE id = $${paramIndex} 
      RETURNING *
    `;

    const result = await primaryPool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Product not found' 
      });
    }

    // Invalidation du cache
    const cacheKey = `product:${productId}`;
    if (redisAvailable) {
      try {
        await redisClient.del(cacheKey);
        console.log(`Cache invalidated for ${cacheKey}`);
      } catch (cacheErr) {
        console.warn('Cache invalidation error:', cacheErr);
      }
    }

    res.json({
      success: true,
      source: 'primary',
      cache_invalidated: redisAvailable,
      data: result.rows[0]
    });
  } catch (err) {
    console.error('Error updating product:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Database error',
      details: err.message 
    });
  }
});

// DELETE /products/:id - Supprimer un produit
app.delete('/products/:id', async (req, res) => {
  const productId = parseInt(req.params.id);

  try {
    const result = await primaryPool.query(
      'DELETE FROM products WHERE id = $1 RETURNING *',
      [productId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: 'Product not found' 
      });
    }

    // Invalidation du cache
    const cacheKey = `product:${productId}`;
    if (redisAvailable) {
      try {
        await redisClient.del(cacheKey);
      } catch (cacheErr) {
        console.warn('Cache invalidation error:', cacheErr);
      }
    }

    res.json({
      success: true,
      source: 'primary',
      cache_invalidated: redisAvailable,
      data: result.rows[0]
    });
  } catch (err) {
    console.error('Error deleting product:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Database error',
      details: err.message 
    });
  }
});

// Statistiques du cache
app.get('/cache/stats', async (req, res) => {
  if (!redisAvailable) {
    return res.json({
      success: false,
      error: 'Redis not available'
    });
  }

  try {
    const info = await redisClient.info('stats');
    const keys = await redisClient.keys('product:*');
    
    res.json({
      success: true,
      redis_available: redisAvailable,
      cached_products: keys.length,
      keys: keys,
      info: info
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Vider le cache
app.delete('/cache', async (req, res) => {
  if (!redisAvailable) {
    return res.json({
      success: false,
      error: 'Redis not available'
    });
  }

  try {
    const keys = await redisClient.keys('product:*');
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
    
    res.json({
      success: true,
      message: `Deleted ${keys.length} cache entries`
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 API running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});

// Gestion de la fermeture propre
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing connections...');
  await primaryPool.end();
  await replicaPool.end();
  if (redisClient) {
    await redisClient.quit();
  }
  process.exit(0);
});
