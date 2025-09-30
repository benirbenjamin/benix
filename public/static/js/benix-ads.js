// BenixAds - Standalone Ads Delivery Script
(function(w, d) {
  'use strict';

  // Configuration
  const config = {
    apiBase: '/api/ads',
    scriptId: 'benix-ads-script',
    version: '1.0.0',
    defaultStyles: `
      .benix-ad-unit {
        display: block;
        width: 100%;
        margin: 10px 0;
        overflow: hidden;
        position: relative;
      }
      .benix-ad-unit img {
        width: 100%;
        height: auto;
        display: block;
      }
      .benix-ad-placeholder {
        text-align: center;
        padding: 20px;
        background: #f8f9fa;
        border: 1px solid #dee2e6;
        border-radius: 4px;
        cursor: pointer;
      }
    `
  };

  // Main BenixAds Class
  class BenixAds {
    constructor() {
      this.slots = new Map();
      this.initialized = false;
      this.viewportObserver = null;
      this.scriptElement = d.getElementById(config.scriptId);
      this.publisherId = this.scriptElement?.getAttribute('data-publisher-id');
    }

    // Initialize the ads system
    init() {
      if (this.initialized) return;
      
      // Inject styles
      this.injectStyles();
      
      // Setup viewport observer for impression tracking
      this.setupViewportObserver();
      
      // Find all ad slots
      this.scanForAdSlots();
      
      // Mark as initialized
      this.initialized = true;
      
      // Log initialization
      console.log('BenixAds initialized:', {
        publisherId: this.publisherId,
        slots: this.slots.size
      });
    }

    // Inject required styles
    injectStyles() {
      const style = d.createElement('style');
      style.textContent = config.defaultStyles;
      d.head.appendChild(style);
    }

    // Setup intersection observer for impression tracking
    setupViewportObserver() {
      this.viewportObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              const slot = this.slots.get(entry.target.id);
              if (slot?.banner) {
                this.trackImpression(slot.banner.id);
                // Stop observing after first impression
                this.viewportObserver.unobserve(entry.target);
              }
            }
          });
        },
        { threshold: 0.5 }
      );
    }

    // Scan page for ad slots
    scanForAdSlots() {
      d.querySelectorAll('[data-benix-ad]').forEach(element => {
        const slotId = element.id || `benix-ad-${Math.random().toString(36).substr(2, 9)}`;
        element.id = slotId;
        
        const slot = {
          element,
          size: element.getAttribute('data-benix-size') || 'responsive',
          format: element.getAttribute('data-benix-format') || 'display',
          banner: null
        };
        
        this.slots.set(slotId, slot);
        this.loadAd(slotId);
      });
    }

    // Load ad for a specific slot
    async loadAd(slotId) {
      const slot = this.slots.get(slotId);
      if (!slot) return;

      try {
        const response = await fetch(`${config.apiBase}/serve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            publisherId: this.publisherId,
            slotId,
            size: slot.size,
            format: slot.format,
            url: w.location.href
          })
        });

        if (!response.ok) throw new Error('Failed to load ad');
        
        const banner = await response.json();
        if (!banner) {
          this.showPlaceholder(slot);
          return;
        }

        slot.banner = banner;
        this.renderAd(slot);
        
        // Start viewability tracking
        this.viewportObserver.observe(slot.element);

      } catch (error) {
        console.error('Failed to load ad:', error);
        this.showPlaceholder(slot);
      }
    }

    // Render ad in slot
    renderAd(slot) {
      const { element, banner } = slot;
      if (!element || !banner) return;

      element.innerHTML = `
        <div class="benix-ad-unit" style="cursor:pointer">
          <img src="${banner.image_url}" 
               alt="${banner.title || 'Advertisement'}"
               width="100%"
               height="auto" />
        </div>
      `;

      element.onclick = (e) => {
        e.preventDefault();
        this.handleClick(banner);
      };
    }

    // Show placeholder for empty/error states
    showPlaceholder(slot) {
      const { element } = slot;
      if (!element) return;

      element.innerHTML = `
        <div class="benix-ad-placeholder">
          <i class="fas fa-bullhorn"></i>
          <p>Advertise Here</p>
        </div>
      `;

      element.onclick = () => {
        w.open('https://wa.me/250783987223?text=Hello%20admin%20of%20benixspace%20i%20want%20to%20advertise%20on%20your%20platform', '_blank');
      };
    }

    // Handle banner click
    handleClick(banner) {
      if (!banner?.id || !banner?.url) return;
      
      fetch(`${config.apiBase}/click`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          bannerId: banner.id,
          url: w.location.href
        })
      }).then(response => {
        if (!response.ok) throw new Error('Failed to track click');
        w.open(banner.url, '_blank');
      }).catch(error => {
        console.error('Click tracking failed:', error);
        w.open(banner.url, '_blank');
      });
    }

    // Track impression
    trackImpression(bannerId) {
      if (!bannerId) return;
      
      fetch(`${config.apiBase}/impression`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          bannerId,
          url: w.location.href
        })
      }).catch(error => {
        console.error('Impression tracking failed:', error);
      });
    }
  }

  // Initialize when DOM is ready
  const initAds = () => {
    w.benixAds = new BenixAds();
    w.benixAds.init();
  };

  if (d.readyState === 'loading') {
    d.addEventListener('DOMContentLoaded', initAds);
  } else {
    initAds();
  }

})(window, document);