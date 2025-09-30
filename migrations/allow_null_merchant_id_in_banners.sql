-- Allow NULL values for merchant_id in banners table
ALTER TABLE banners MODIFY COLUMN merchant_id INT NULL;