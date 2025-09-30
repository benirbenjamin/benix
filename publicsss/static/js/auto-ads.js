// Auto Ads System
class BenixAutoAds {
    constructor(options = {}) {
        this.options = {
            minDistanceBetweenAds: options.minDistanceBetweenAds || 800,
            maxAdsPerPage: options.maxAdsPerPage || 4,
            minContentLength: options.minContentLength || 300,
            mobileMinDistanceBetweenAds: options.mobileMinDistanceBetweenAds || 500,
            maxMobileAdsPerPage: options.maxMobileAdsPerPage || 3,
            excludedElements: options.excludedElements || ['header', 'footer', 'nav', '.no-ads', '[data-no-ads]'],
            preserveAdsense: true,
            adStyles: window.benixAdsConfig?.adStyles || {
                card: true,
                badge: true,
                banner: true,
                overlay: false
            },
            animationStyle: window.benixAdsConfig?.animationStyle || 'fade-slide',
            ...options
        };
        
        this.insertedAds = 0;
        this.lastAdPosition = 0;
        this.bannerCache = null;
        this.initialized = false;
        this.isMobile = window.innerWidth < 768;

        // Listen for resize events to handle orientation changes
        window.addEventListener('resize', () => {
            const wasMobile = this.isMobile;
            this.isMobile = window.innerWidth < 768;
            if (wasMobile !== this.isMobile) {
                this.reAnalyzePage();
            }
        });
    }

    async init() {
        if (this.initialized) return;
        this.initialized = true;

        // Wait for DOM to be fully loaded
        if (document.readyState !== 'complete') {
            await new Promise(resolve => window.addEventListener('load', resolve));
        }

        // Add responsive styles
        this.addStyles();

        // Initialize mutation observer to handle dynamic content
        this.observeContentChanges();
        
        // Start initial ad placement
        this.analyzePage();
    }

    addStyles() {
        const styles = document.createElement('style');
        styles.textContent = `
            .benix-auto-ad {
                margin: 20px 0;
                text-align: center;
                clear: both;
                width: 100%;
                max-width: 100%;
                overflow: hidden;
                position: relative;
                min-height: 90px;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 8px;
                transition: all 0.3s ease;
            }

            .benix-auto-ad img {
                max-width: 100%;
                height: auto;
                margin: 0 auto;
                display: block;
                transition: transform 0.3s ease;
            }

            .benix-auto-ad:hover img {
                transform: scale(1.02);
            }

            @media (max-width: 768px) {
                .benix-auto-ad {
                    margin: 15px 0;
                    min-height: 60px;
                    padding: 10px;
                }
                
                .benix-auto-ad img {
                    max-height: 100vh;
                    object-fit: contain;
                }
            }

            .benix-auto-ad-mobile {
                width: 100%;
                max-width: 320px;
                margin: 15px auto;
            }

            .benix-auto-ad-desktop {
                width: 100%;
                max-width: 728px;
                margin: 20px auto;
            }
        `;
        document.head.appendChild(styles);
    }

    async reAnalyzePage() {
        // Remove existing ads
        const existingAds = document.querySelectorAll('.benix-auto-ad');
        existingAds.forEach(ad => ad.remove());
        
        // Reset counters
        this.insertedAds = 0;
        this.lastAdPosition = 0;
        
        // Reanalyze the page
        await this.analyzePage();
    }

    async fetchBanners() {
        try {
            const response = await fetch('/ads/serve');
            const data = await response.json();
            if (data && !data.error) {
                // Transform banner data to match our expected format
                const banner = {
                    id: data.id,
                    title: data.title,
                    description: data.merchant || 'Special Offer',
                    image_url: data.image_url,
                    target_url: data.url,
                    format: data.format
                };
                this.bannerCache = [banner];
                return [banner];
            }
        } catch (error) {
            console.error('Error fetching banners:', error);
        }
        return [];
    }

    async analyzePage() {
        const maxAds = this.isMobile ? this.options.maxMobileAdsPerPage : this.options.maxAdsPerPage;
        if (this.insertedAds >= maxAds) return;
        
        // Insert a banner ad at the very top
        if (this.insertedAds === 0) {
            const mainContent = document.querySelector('.viewer-container, .content-card, main, article, .content');
            if (mainContent) {
                await this.insertAd(mainContent, 'before', 'banner');
            }
        }

        // Get all potential content containers
        const containers = this.findContentContainers();
        
        // Analyze each container for ad placement
        for (const container of containers) {
            if (this.insertedAds >= maxAds) break;
            
            // Skip if container is too small
            if (container.textContent.length < this.options.minContentLength) continue;
            
            // Find potential ad positions within container
            const positions = this.findAdPositions(container);
            
            // Insert ads at suitable positions
            for (const position of positions) {
                if (this.insertedAds >= maxAds) break;
                await this.insertAd(position);
            }
        }

        // If on mobile and we haven't reached max ads, try to insert one at the bottom
        if (this.isMobile && this.insertedAds < maxAds) {
            const contentEnd = document.querySelector('.content-card, main, article');
            if (contentEnd) {
                await this.insertAd(contentEnd, 'after');
            }
        }
    }

    findContentContainers() {
        // Get main content areas, excluding header, footer, nav, etc.
        const allElements = document.body.getElementsByTagName('*');
        const containers = [];
        const excludedSelectors = this.options.excludedElements.join(',');
        
        for (const element of allElements) {
            // Skip excluded elements
            if (element.matches(excludedSelectors)) continue;
            if (this.isExcluded(element)) continue;
            
            // Check if element has enough content
            if (this.isGoodContainer(element)) {
                containers.push(element);
            }
        }
        
        return containers;
    }

    isGoodContainer(element) {
        // Check if element has significant content
        const text = element.textContent.trim();
        const hasEnoughText = text.length >= this.options.minContentLength;
        const hasParagraphs = element.getElementsByTagName('p').length > 0;
        const hasImages = element.getElementsByTagName('img').length > 0;
        
        return (hasEnoughText && (hasParagraphs || hasImages));
    }

    isExcluded(element) {
        // Check if element or its parents are marked as no-ads
        let current = element;
        while (current) {
            if (current.classList.contains('no-ads') || 
                current.hasAttribute('data-no-ads') ||
                current.tagName.toLowerCase() === 'script' ||
                current.tagName.toLowerCase() === 'style') {
                return true;
            }
            current = current.parentElement;
        }
        return false;
    }

    findAdPositions(container) {
        const positions = [];
        const paragraphs = container.getElementsByTagName('p');
        const images = container.getElementsByTagName('img');
        const cards = container.querySelectorAll('.card');
        const badges = container.querySelectorAll('.badge');
        
        if (this.isMobile) {
            // Mobile ad positioning strategy
            if (paragraphs.length > 0) {
                positions.push({ element: paragraphs[0], type: 'banner' });
            }
            
            // After cards with card-style ads
            cards.forEach(card => {
                positions.push({ element: card, type: 'card' });
            });

            // Near badges with badge-style ads
            badges.forEach(badge => {
                positions.push({ element: badge, type: 'badge' });
            });
            
            // After significant images
            let lastImagePos = -1;
            for (const img of images) {
                const imgPos = img.getBoundingClientRect().top;
                if (imgPos - lastImagePos > this.options.mobileMinDistanceBetweenAds) {
                    if (this.isGoodImageForAd(img)) {
                        positions.push({ element: img, type: 'banner' });
                        lastImagePos = imgPos;
                    }
                }
            }
            
            // Before last paragraph
            if (paragraphs.length > 2) {
                positions.push({ element: paragraphs[paragraphs.length - 1], type: 'banner' });
            }
        } else {
            // Desktop ad positioning strategy
            if (paragraphs.length > 2) {
                positions.push({ element: paragraphs[0], type: 'banner' }); // Top banner
                
                if (paragraphs.length > 4) {
                    const middleIndex = Math.floor(paragraphs.length / 2);
                    positions.push({ element: paragraphs[middleIndex], type: 'card' }); // Card in middle
                }
                
                if (paragraphs.length > 3) {
                    positions.push({ element: paragraphs[paragraphs.length - 2], type: 'banner' });
                }
            }
            
            // Near cards with card-style ads
            cards.forEach(card => {
                positions.push({ element: card, type: 'card' });
            });

            // Near badges with badge-style ads
            badges.forEach(badge => {
                positions.push({ element: badge, type: 'badge' });
            });
            
            // After suitable images
            for (const img of images) {
                if (this.isGoodImageForAd(img)) {
                    positions.push({ element: img, type: 'banner' });
                }
            }
        }
        
        return this.filterPositions(positions);
    }

    isGoodImageForAd(img) {
        if (this.isMobile) {
            return img.width >= 200 && img.height >= 150;
        }
        return img.width >= 300 && img.height >= 200;
    }

    filterPositions(positions) {
        const minDistance = this.isMobile ? 
            this.options.mobileMinDistanceBetweenAds : 
            this.options.minDistanceBetweenAds;
            
        return positions.filter((pos, index) => {
            if (index === 0) return true;
            
            const prevPos = positions[index - 1];
            const distance = Math.abs(pos.getBoundingClientRect().top - 
                                   prevPos.getBoundingClientRect().top);
            
            return distance >= minDistance;
        });
    }

    async insertAd(position, placement = 'after', type = 'banner') {
        const minDistance = this.isMobile ? 
            this.options.mobileMinDistanceBetweenAds : 
            this.options.minDistanceBetweenAds;

        // Use position.element if it's a position object
        const element = position.element || position;
        const adType = position.type || type;

        // Don't insert if too close to last ad
        const positionTop = element.getBoundingClientRect().top;
        if (Math.abs(positionTop - this.lastAdPosition) < minDistance) {
            return;
        }

        // Don't insert if too close to AdSense
        if (this.options.preserveAdsense && this.isNearAdsense(element)) {
            return;
        }

        // Fetch fresh banners if needed
        if (!this.bannerCache || !this.bannerCache.length) {
            await this.fetchBanners();
        }

        if (!this.bannerCache || !this.bannerCache.length) return;

        // Get and remove a banner from cache
        const banner = this.bannerCache.shift();
        
        // Create ad container with appropriate style
        const adContainer = document.createElement('div');
        adContainer.className = `benix-ad-container benix-ad-${adType} ${this.options.animationStyle}`;
        
        // Create ad content based on type
        let adContent = '';
        
        switch(adType) {
            case 'banner':
                adContent = `
                    <div class="benix-ad-banner">
                        <img src="${banner.image_url}" alt="${banner.title}" class="ad-image">
                        <div class="benix-ad-content">
                            <h3 class="benix-ad-title">${banner.title}</h3>
                            <p class="benix-ad-description">${banner.description || 'Check this out!'}</p>
                            <a href="${banner.target_url || banner.click_url}" class="benix-ad-cta" 
                               target="_blank" rel="noopener noreferrer" 
                               onclick="event.preventDefault(); window.trackBannerClick(${banner.id}).then(() => window.location.href = '${banner.target_url || banner.url}')">
                                Learn More
                            </a>
                        </div>
                    </div>
                `;
                break;

            case 'card':
                adContent = `
                    <div class="benix-ad-card">
                        <img src="${banner.image_url}" alt="${banner.title}" class="ad-image">
                        <div class="benix-ad-content">
                            <h3 class="benix-ad-title">${banner.title}</h3>
                            <p class="benix-ad-description">${banner.description || 'Discover more'}</p>
                            <a href="${banner.target_url || banner.click_url}" class="benix-ad-cta" 
                               target="_blank" rel="noopener noreferrer"
                               onclick="event.preventDefault(); window.trackBannerClick(${banner.id}).then(() => window.location.href = '${banner.target_url || banner.url}')">
                                View Details
                            </a>
                        </div>
                    </div>
                `;
                break;

            case 'badge':
                adContent = `
                    <div class="benix-ad-badge">
                        <img src="${banner.image_url}" alt="${banner.title}" class="ad-image">
                        <div class="benix-ad-content">
                            <h3 class="benix-ad-title">${banner.title}</h3>
                            <a href="${banner.target_url || banner.click_url}" class="benix-ad-cta" 
                               target="_blank" rel="noopener noreferrer"
                               onclick="event.preventDefault(); window.trackBannerClick(${banner.id}).then(() => window.location.href = '${banner.target_url || banner.url}')">
                                Check Now
                            </a>
                        </div>
                    </div>
                `;
                break;
        }

        adContainer.innerHTML = adContent;

        // Insert the ad
        if (placement === 'before') {
            position.parentNode.insertBefore(adContainer, position);
        } else if (placement === 'after') {
            position.parentNode.insertBefore(adContainer, position.nextSibling);
        }
        
        this.insertedAds++;
        this.lastAdPosition = positionTop;

        // Track impression
        this.trackImpression(banner.id);
    }

    isNearAdsense(position) {
        const adsenseAds = document.getElementsByClassName('adsbygoogle');
        const posRect = position.getBoundingClientRect();
        const minDistance = this.isMobile ? 500 : 1000; // Closer spacing allowed on mobile
        
        for (const ad of adsenseAds) {
            const adRect = ad.getBoundingClientRect();
            const distance = Math.abs(posRect.top - adRect.top);
            if (distance < minDistance) return true;
        }
        
        return false;
    }

    async trackImpression(bannerId) {
        // Using existing banner_views tracking
        try {
            await fetch('/ads/view/' + bannerId, { 
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
        } catch (error) {
            console.error('Error tracking impression:', error);
        }
    }

    observeContentChanges() {
        // Create mutation observer for dynamic content
        const observer = new MutationObserver((mutations) => {
            let shouldAnalyze = false;
            
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    // Check if added nodes contain significant content
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1 && // Element node
                            node.textContent.length >= this.options.minContentLength) {
                            shouldAnalyze = true;
                            break;
                        }
                    }
                }
            }
            
            if (shouldAnalyze) {
                this.analyzePage();
            }
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }
}

// Initialize auto ads system
window.addEventListener('DOMContentLoaded', () => {
    window.benixAds = new BenixAutoAds({
        minDistanceBetweenAds: 800,
        mobileMinDistanceBetweenAds: 500,
        maxAdsPerPage: 4,
        maxMobileAdsPerPage: 3,
        minContentLength: 300
    });
    window.benixAds.init();
});

// Global tracking functions
window.trackBannerClick = async (bannerId) => {
    try {
        const response = await fetch('/ads/click/' + bannerId, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        return response;
    } catch (error) {
        console.error('Error tracking click:', error);
        return Promise.reject(error);
    }
};

window.trackBannerImpression = async (bannerId) => {
    try {
        await fetch('/ads/view/' + bannerId, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
    } catch (error) {
        console.error('Error tracking impression:', error);
    }
};