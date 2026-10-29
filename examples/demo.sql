-- MiniSQL demo: a tour of the dialect. Run it with:
--   node src/cli.js demo.db.json examples/demo.sql

CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL, price REAL, stock INTEGER DEFAULT 0);
INSERT INTO books VALUES
  (1, 'Dune', 19.99, 12),
  (2, 'Neuromancer', 14.50, 0),
  (3, 'Foundation', 17.00, 5),
  (4, 'Snow Crash', 16.25, 3);

-- In-stock books, most expensive first.
SELECT title, price FROM books WHERE stock > 0 ORDER BY price DESC;

-- Whole-table aggregates.
SELECT COUNT(*) AS total, SUM(stock) AS units, AVG(price) AS avg_price FROM books;

-- Restock, then check the shelf.
UPDATE books SET stock = 20 WHERE id = 2;
SELECT * FROM books WHERE stock >= 10 ORDER BY title;

-- Clean up and list what remains.
DELETE FROM books WHERE stock = 0;
SHOW TABLES;
