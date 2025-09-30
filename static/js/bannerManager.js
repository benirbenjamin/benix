((win) => {
  'use strict';
  
  // Constants
  const INTERVALS = {
    banner1: 7000,
    banner2: 10000,
    banner3: 13000
  };
  
  const WHATSAPP_URL = "https://wa.me/250783987223?text=" + 
    encodeURIComponent("Hello BenixSpace admin, I want to advertise");
  
  // Banner Manager Implementation
  win.BannerManager = {
    // Private state
    _state: {
      elements: new Map(),
      banners: [],
      indices: new Map(),
      timers: new Map()
    },
    
    // Initialize banner system
    init(bannerData = []) {
      // Clear existing state
      this.cleanup();
      
      // Find banner containers
      document.querySelectorAll('.banner-container[id^="banner"]').forEach(el => {
        if (el?.id) {
          this._state.elements.set(el.id, el);
          this._state.indices.set(el.id, 0);
        }
      });
      
      // Process banner data
      this._state.banners = this._prioritizeBanners(bannerData);
      
      // Start rotations
      this._state.elements.forEach((el, id) => {
        this._startRotation(id);
      });
      
      // Log initialization
      console.log('Banner system initialized:', {
        containers: this._state.elements.size,
        banners: this._state.banners.length
      });
    },
    
    // Clean up resources
    cleanup() {
      this._state.timers.forEach(timer => clearTimeout(timer));
      this._state.elements.clear();
      this._state.indices.clear();
      this._state.timers.clear();
      this._state.banners = [];
    },
    
    // Handle banner clicks with monetization
    _handleClick(banner) {
      if (!banner?.id || !banner?.url) return;
      
      // Track click with monetization
      fetch('/api/banners/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bannerId: banner.id })
      }).then(response => {
        if (!response.ok) {
          throw new Error('Failed to track banner click');
        }
        // Open URL only after successful tracking
        window.open(banner.url, '_blank', 'noopener,noreferrer');
      }).catch(error => {
        console.error('Banner click tracking failed:', error);
        // Still open URL if tracking fails to maintain user experience
        window.open(banner.url, '_blank', 'noopener,noreferrer');
      });
    },
    
    // Impression tracking with monetization (public for onload callback)
    onImpression(bannerId) {
      if (!bannerId) return;
      
      fetch('/api/banners/impression', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bannerId })
      }).then(response => {
        if (!response.ok) {
          console.error('Failed to track banner impression');
        }
      }).catch(error => {
        console.error('Banner impression tracking failed:', error);
      });
    },
    
    // Private Methods
    _prioritizeBanners(banners) {
      if (!Array.isArray(banners) || !banners.length) return [];
      
      return banners
        .filter(banner => 
          banner.active && 
          banner.remaining_budget > 0 &&
          banner.image_url
        )
        .map(banner => {
          const impressions = banner.impressions || 0;
          const clicks = banner.clicks || 0;
          const ctr = impressions > 0 ? clicks / impressions : 0;
          const budget = banner.remaining_budget / banner.budget;
          
          return {
            ...banner,
            score: (ctr * 0.7) + (budget * 0.3)
          };
        })
        .sort((a, b) => b.score - a.score);
    },
    
    _startRotation(id) {
      if (!id || !this._state.elements.has(id)) return;
      
      const updateBanner = () => {
        const el = this._state.elements.get(id);
        if (!el) return;
        
        const index = this._state.indices.get(id);
        const banner = this._state.banners[index % this._state.banners.length];
        
        this._updateContent(el, banner);
        this._state.indices.set(id, (index + 1) % this._state.banners.length);
        
        const interval = INTERVALS[id] || 7000;
        const timer = setTimeout(updateBanner, interval);
        this._state.timers.set(id, timer);
      };
      
      // Start initial update
      updateBanner();
    },
    
    _updateContent(el, banner) {
      if (!el) return;
      
      try {
        if (!banner?.image_url) {
          this._showPlaceholder(el);
          return;
        }
        
        el.innerHTML = `
          <div class="ad-content" style="cursor:pointer">
            <img src="${banner.image_url}" 
                 class="banner-image w-100 h-100"
                 alt="${banner.title || 'Advertisement'}"
                 onload="BannerManager.onImpression('${banner.id}')" />
          </div>
        `;
        
        el.onclick = (e) => {
          e.preventDefault();
          this._handleClick(banner);
        };
        
      } catch (err) {
        console.error('Banner update error:', err);
        this._showPlaceholder(el);
      }
    },
    
    _showPlaceholder(el) {
      if (!el) return;
      
      el.innerHTML = `
        <div class="advertise-placeholder" style="cursor:pointer">
          <i class="fas fa-bullhorn fa-2x mb-2"></i>
          <h6>Advertise Here</h6>
          <p class="small mb-2">Reach thousands of customers</p>
        </div>
      `;
      
      el.onclick = () => window.open(WHATSAPP_URL, '_blank', 'noopener,noreferrer');
    },
    
    _handleClick(banner) {
      if (!banner?.id || !banner?.url) return;
      
      // Track click
      fetch('/api/banners/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bannerId: banner.id })
      }).catch(console.error);
      
      // Open URL in new tab
      window.open(banner.url, '_blank', 'noopener,noreferrer');
    }
  };
  
  // Auto-initialize when DOM is ready
  document.addEventListener('DOMContentLoaded', () => {
    const banners = window.banners || [];
    BannerManager.init(banners);
    
    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      BannerManager.cleanup();
    });
  });
  
})(window);