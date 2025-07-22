# Currency Converter Module for BenixSpace

## Overview

This module provides a global currency conversion system that automatically detects USD prices on any page and converts them to the selected currency (RWF, KES, UGX, or USD). The conversion happens in real-time on the frontend without affecting backend data or database values.

## Features

1. **Global Currency Switcher**: Dropdown in the navigation bar allows users to select their preferred currency
2. **Automatic Price Detection**: Detects all USD prices in the format "$123.45" anywhere on the page
3. **Real-time Conversion**: Fetches live exchange rates from external APIs
4. **Dynamic Content Support**: Uses MutationObserver to detect and convert prices in dynamically added content
5. **Persistent Selection**: User's currency choice is saved in localStorage
6. **Fallback Support**: Uses backup APIs and fallback rates if primary API fails
7. **Mobile Responsive**: Works seamlessly on all device sizes

## Implementation

### Files Created

1. **`views/partials/currency-switcher.ejs`** - Main partial containing HTML, CSS, and JavaScript
2. **`views/currency-test.ejs`** - Test page to demonstrate functionality
3. **Updated `views/partials/navbar.ejs`** - Added currency switcher to navigation
4. **Updated `routes/index.js`** - Added test route

### Integration

The currency converter is integrated as a partial view that loads on every page:

```html
<!-- In navbar.ejs -->
<li class="nav-item d-flex align-items-center me-2">
  <%- include('currency-switcher') %>
</li>
```

## Supported Currencies

- **USD ($)** - US Dollar (base currency)
- **RWF (₣)** - Rwandan Franc
- **KES (KSh)** - Kenyan Shilling  
- **UGX (USh)** - Ugandan Shilling

## How It Works

### 1. Price Detection
The module automatically finds all text content matching the pattern:
- `$123.45`
- `$123`
- `$ 123.45` (with space)
- `$1,234.56` (with comma separators)

### 2. Exchange Rate Fetching
- Primary API: `https://api.exchangerate-api.com/v4/latest/USD`
- Fallback API: `https://api.fxratesapi.com/latest?base=USD`
- Rates are cached for 5 minutes
- Auto-refreshes every 5 minutes
- Includes retry logic with exponential backoff

### 3. Price Conversion
- Stores original USD values in `data-original-content` attributes
- Converts to selected currency using live rates
- Formats numbers appropriately for each currency:
  - USD: 2 decimal places ($25.99)
  - RWF/UGX: No decimals (₣25,000)
  - KES: 2 decimal places (KSh2,500.00)

### 4. Dynamic Content Handling
Uses MutationObserver to detect:
- New DOM elements added
- Text content changes
- Automatically converts prices in new content

## API Features

The module exposes a global `CurrencyConverter` object with methods:

```javascript
// Get current selected currency
CurrencyConverter.getCurrentCurrency()

// Get current exchange rates
CurrencyConverter.getExchangeRates()

// Manually refresh rates
CurrencyConverter.refreshRates()

// Convert a specific price
CurrencyConverter.convertPrice(amount, targetCurrency)

// Manually trigger conversion of all prices
CurrencyConverter.convertAllPrices()

// Reset all prices to original USD values
CurrencyConverter.resetPrices()
```

## Testing

Visit `/currency-test` to see the converter in action with various price formats:
- Product cards with different price styles
- Tables with price comparisons  
- Dynamic content addition
- Real-time currency info display

## Configuration

Key configuration options in the script:

```javascript
const CONFIG = {
  API_URL: 'https://api.exchangerate-api.com/v4/latest/USD',
  FALLBACK_API: 'https://api.fxratesapi.com/latest?base=USD',
  CACHE_DURATION: 5 * 60 * 1000, // 5 minutes
  UPDATE_INTERVAL: 300000, // 5 minutes auto-update
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000
};
```

## Browser Support

- Modern browsers with ES6+ support
- MutationObserver support (IE11+)
- localStorage support
- Fetch API support

## Error Handling

- Graceful fallback to approximate rates if API fails
- Retry logic with exponential backoff
- Visual error indicators for users
- Console logging for debugging

## Performance Considerations

- Efficient price detection using regex
- Debounced conversion calls (200ms)
- Cached exchange rates
- Minimal DOM manipulation
- Optimized MutationObserver configuration

## Limitations

- Only converts prices displayed as text content
- Does not convert prices in form inputs or data attributes
- Requires JavaScript enabled
- Backend/database values remain in USD
- API rate limits may apply (usually 1000+ requests/month free)

## Customization

### Adding New Currencies

1. Add currency to dropdown options in the HTML
2. Add currency symbol to `CURRENCY_SYMBOLS` object
3. Ensure exchange rate API supports the currency

### Changing Price Detection Pattern

Modify the `priceRegex` variable to match different price formats:

```javascript
const priceRegex = /\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g;
```

### Using Different APIs

Replace the API URLs in the CONFIG object and adjust the response parsing logic accordingly.

## Troubleshooting

1. **Prices not converting**: Check browser console for errors, verify API connectivity
2. **Wrong exchange rates**: Check if API is accessible, try refreshing rates manually
3. **Dynamic content not converting**: Verify MutationObserver is working, check console for errors
4. **Currency selection not persisting**: Check localStorage permissions in browser

## Security Notes

- All conversion happens on frontend only
- No sensitive data sent to external APIs
- Backend/database remains secure with USD values
- Rate limiting handled gracefully

This implementation provides a robust, user-friendly currency conversion system that enhances the user experience without compromising data integrity or backend security.
