-- Create ads table
CREATE TABLE IF NOT EXISTS ads (
    id UUID PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    image_url TEXT NOT NULL,
    target_url TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    impressions INT DEFAULT 0,
    clicks INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Insert sample ads
INSERT INTO ads (id, title, description, image_url, target_url, status)
VALUES 
    (
        'ad67e2d0-5c3e-11ec-bf63-0242ac130002',
        'Special Discount on Premium Products',
        'Get 30% off on all premium products. Limited time offer!',
        '/static/img/ads/premium-products.jpg',
        'https://benixspace.com/premium-products',
        'active'
    ),
    (
        'b8f2e3d0-5c3e-11ec-bf63-0242ac130003',
        'Join Our Affiliate Program',
        'Earn up to 50% commission on every sale. Start earning today!',
        '/static/img/ads/affiliate-program.jpg',
        'https://benixspace.com/affiliate-program',
        'active'
    ),
    (
        'c9d3e4f0-5c3e-11ec-bf63-0242ac130004',
        'Launch Your Online Store',
        'Create your online store in minutes. No coding required!',
        '/static/img/ads/online-store.jpg',
        'https://benixspace.com/create-store',
        'active'
    ),
    (
        'd0e4f5g0-5c3e-11ec-bf63-0242ac130005',
        'Digital Marketing Tools',
        'Boost your sales with our advanced marketing tools',
        '/static/img/ads/marketing-tools.jpg',
        'https://benixspace.com/marketing-tools',
        'active'
    );