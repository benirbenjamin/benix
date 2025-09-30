// Currency Service for Exchange Rate Management
const axios = require('axios');

class CurrencyService {
  constructor(pool) {
    this.pool = pool;
    this.baseUrl = process.env.EXCHANGE_RATE_API_URL || 'https://api.exchangerate-api.com/v4/latest';
    this.fallbackUrl = 'https://api.fxratesapi.com/latest';
    this.updateInterval = 60 * 60 * 1000; // Update every hour
    this.lastUpdate = null;
  }

  // Validate currency code
  isValidCurrencyCode(currency) {
    return typeof currency === 'string' && 
           currency.length === 3 && 
           /^[A-Z]{3}$/.test(currency);
  }

  // Get exchange rate from API with fallback
  async fetchExchangeRate(fromCurrency = 'RWF', toCurrency = 'USD') {
    // Validate input currencies
    if (!this.isValidCurrencyCode(fromCurrency) || !this.isValidCurrencyCode(toCurrency)) {
      console.error('Invalid currency code:', { fromCurrency, toCurrency });
      throw new Error('Invalid currency code provided');
    }

    try {
      // Try multiple APIs for better reliability
      const apis = [
        {
          url: `https://api.exchangerate-api.com/v4/latest/${fromCurrency}`,
          parser: (data) => data.rates[toCurrency]
        },
        {
          url: `https://api.fxratesapi.com/latest?base=${fromCurrency}&symbols=${toCurrency}`,
          parser: (data) => data.rates[toCurrency]
        },
        {
          url: `https://api.exchangerate.host/latest?base=${fromCurrency}&symbols=${toCurrency}`,
          parser: (data) => data.rates[toCurrency]
        }
      ];

      for (const api of apis) {
        try {
          const response = await axios.get(api.url, {
            timeout: 10000,
            headers: {
              'User-Agent': 'BenixSpace/1.0'
            }
          });
          
          if (response.data && response.status === 200) {
            const rate = api.parser(response.data);
            if (rate && !isNaN(rate) && rate > 0) {
              console.log(`Successfully fetched rate from ${api.url}: 1 ${fromCurrency} = ${rate} ${toCurrency}`);
              return rate;
            }
          }
        } catch (apiError) {
          console.log(`API ${api.url} failed:`, apiError.message);
          continue; // Try next API
        }
      }
      
      throw new Error('All exchange rate APIs failed');
    } catch (error) {
      console.error(`Error fetching exchange rate for ${fromCurrency} to ${toCurrency}:`, error.message);
      
      // Return fallback rate from database or default
      const fallbackRate = await this.getFallbackRate(fromCurrency, toCurrency);
      if (fallbackRate) {
        console.log(`Using fallback rate: 1 ${fromCurrency} = ${fallbackRate} ${toCurrency}`);
        return fallbackRate;
      }
      
      // Ultimate fallback rates for common conversions
      const fallbackRates = {
        'RWF-USD': 0.00069,   // 1 RWF = 0.00069 USD (more accurate rate)
        'USD-RWF': 1449.28,   // 1 USD = 1449.28 RWF (inverse of 0.00069)
        'RWF-UGX': 2.5,       // 1 RWF = 2.5 UGX
        'RWF-KES': 0.1,       // 1 RWF = 0.1 KES
        'USD-UGX': 3700,      // 1 USD = 3700 UGX
        'USD-KES': 130,       // 1 USD = 130 KES
        'USD-EUR': 0.85,      // 1 USD = 0.85 EUR
        'USD-GBP': 0.75       // 1 USD = 0.75 GBP
      };
      
      const rateKey = `${fromCurrency}-${toCurrency}`;
      if (fallbackRates[rateKey]) {
        console.log(`Using hardcoded fallback rate: 1 ${fromCurrency} = ${fallbackRates[rateKey]} ${toCurrency}`);
        return fallbackRates[rateKey];
      }
      
      throw new Error(`Unable to get exchange rate for ${fromCurrency} to ${toCurrency}`);
    }
  }

  // Get fallback rate from database
  async getFallbackRate(fromCurrency, toCurrency) {
    try {
      const [rows] = await this.pool.query(
        'SELECT rate FROM currency_rates WHERE from_currency = ? AND to_currency = ? ORDER BY updated_at DESC LIMIT 1',
        [fromCurrency, toCurrency]
      );
      
      return rows.length > 0 ? parseFloat(rows[0].rate) : null;
    } catch (error) {
      console.error('Error getting fallback rate from database:', error);
      return null;
    }
  }

  // Update exchange rate in database
  async updateExchangeRate(fromCurrency = 'RWF', toCurrency = 'USD') {
    try {
      const rate = await this.fetchExchangeRate(fromCurrency, toCurrency);
      
      await this.pool.query(`
        INSERT INTO currency_rates (from_currency, to_currency, rate, updated_at) 
        VALUES (?, ?, ?, NOW()) 
        ON DUPLICATE KEY UPDATE rate = VALUES(rate), updated_at = VALUES(updated_at)
      `, [fromCurrency, toCurrency, rate]);
      
      console.log(`Updated exchange rate: 1 ${fromCurrency} = ${rate} ${toCurrency}`);
      this.lastUpdate = new Date();
      return rate;
    } catch (error) {
      console.error('Error updating exchange rate:', error);
      throw error;
    }
  }

  // Convert amount from one currency to another
  async convertCurrency(amount, fromCurrency = 'RWF', toCurrency = 'USD') {
    try {
      // Check if we need to update rates (if more than 1 hour old)
      const shouldUpdate = !this.lastUpdate || 
        (Date.now() - this.lastUpdate.getTime()) > this.updateInterval;
      
      let rate;
      if (shouldUpdate) {
        try {
          rate = await this.updateExchangeRate(fromCurrency, toCurrency);
        } catch (updateError) {
          // If update fails, use fallback rate
          rate = await this.getFallbackRate(fromCurrency, toCurrency);
          if (!rate) {
            throw new Error('No exchange rate available');
          }
        }
      } else {
        rate = await this.getFallbackRate(fromCurrency, toCurrency);
        if (!rate) {
          rate = await this.updateExchangeRate(fromCurrency, toCurrency);
        }
      }
      
      const convertedAmount = amount * rate;
      return Math.round(convertedAmount * 100) / 100; // Round to 2 decimal places
    } catch (error) {
      console.error(`Error converting ${amount} ${fromCurrency} to ${toCurrency}:`, error);
      throw error;
    }
  }

  // Convert RWF to USD (most common conversion)
  async convertRwfToUsd(amountRwf) {
    return this.convertCurrency(amountRwf, 'RWF', 'USD');
  }

  // Convert USD to RWF
  async convertUsdToRwf(amountUsd) {
    return this.convertCurrency(amountUsd, 'USD', 'RWF');
  }

  // Get supported currencies for Flutterwave
  getSupportedCurrencies() {
    return [
      { code: 'RWF', name: 'Rwandan Franc', symbol: 'RWF' },
      { code: 'USD', name: 'US Dollar', symbol: '$' },
      { code: 'UGX', name: 'Ugandan Shilling', symbol: 'UGX' },
      { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh' },
      { code: 'TZS', name: 'Tanzanian Shilling', symbol: 'TSh' },
      { code: 'GHS', name: 'Ghanaian Cedi', symbol: 'GH₵' },
      { code: 'NGN', name: 'Nigerian Naira', symbol: '₦' },
      { code: 'ZAR', name: 'South African Rand', symbol: 'R' },
      { code: 'EUR', name: 'Euro', symbol: '€' },
      { code: 'GBP', name: 'British Pound', symbol: '£' }
    ];
  }

  // Get all exchange rates from database
  async getExchangeRates() {
    try {
      const [rates] = await this.pool.query(`
        SELECT from_currency, to_currency, rate, updated_at
        FROM currency_rates
        ORDER BY from_currency, to_currency
      `);
      
      const ratesMap = {};
      rates.forEach(rate => {
        const key = `${rate.from_currency}_${rate.to_currency}`;
        ratesMap[key] = {
          rate: rate.rate,
          updated_at: rate.updated_at
        };
      });
      
      return ratesMap;
    } catch (error) {
      console.error('Error fetching exchange rates:', error);
      return {};
    }
  }

  // Initialize currency service with periodic updates
  async initialize() {
    try {
      // Update initial rates
      await this.updateExchangeRate('RWF', 'USD');
      
      // Set up periodic updates every hour
      setInterval(async () => {
        try {
          await this.updateExchangeRate('RWF', 'USD');
        } catch (error) {
          console.error('Periodic exchange rate update failed:', error);
        }
      }, this.updateInterval);
      
      console.log('Currency service initialized successfully');
    } catch (error) {
      console.error('Currency service initialization failed:', error);
    }
  }
}

module.exports = CurrencyService;
