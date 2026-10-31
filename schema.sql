CREATE TABLE IF NOT EXISTS cans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT,
  country TEXT,
  volume INTEGER,            -- мл
  year INTEGER,
  shape TEXT CHECK (shape IN ('slim', 'wide')),  -- slim = вытянутая, wide = пузатая
  description TEXT,
  cover TEXT,                -- ключ обложки в R2, например cans/1-cover.jpg
  photo TEXT                 -- ключ коллажа в R2, например cans/1.jpg
);
CREATE INDEX IF NOT EXISTS idx_cans_brand ON cans(brand);
CREATE INDEX IF NOT EXISTS idx_cans_country ON cans(country);
CREATE INDEX IF NOT EXISTS idx_cans_volume ON cans(volume);
CREATE INDEX IF NOT EXISTS idx_cans_year ON cans(year);
CREATE INDEX IF NOT EXISTS idx_cans_shape ON cans(shape);

INSERT INTO cans (name, brand, country, volume, year, shape, description) VALUES
 ('Soda water — blueberry/pomegranate', 'AHA', 'United States', 355, 2020, 'wide', 'Тестовая запись'),
 ('Soda water — citrus', 'AHA', 'United States', 473, 2020, 'slim', 'Тестовая запись');
