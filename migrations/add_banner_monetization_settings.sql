-- Add banner monetization settings
INSERT INTO settings (key, value, description, created_at, updated_at)
VALUES 
('banner_cpc', '0.1', 'Cost per click for banner ads (in USD)', NOW(), NOW()),
('banner_cpm', '2.0', 'Cost per thousand impressions for banner ads (in USD)', NOW(), NOW()),
('banner_impression_batch', '200', 'Number of impressions to batch before charging CPM', NOW(), NOW());