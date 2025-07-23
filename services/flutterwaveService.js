// Flutterwave Payment Service
const axios = require('axios');
const crypto = require('crypto');

class FlutterwaveService {
  constructor() {
    this.publicKey = process.env.FLUTTERWAVE_PUBLIC_KEY;
    this.secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
    this.encryptionKey = process.env.FLUTTERWAVE_ENCRYPTION_KEY;
    this.environment = process.env.FLUTTERWAVE_ENVIRONMENT || 'sandbox';
    this.baseUrl = this.environment === 'production' 
      ? 'https://api.flutterwave.com/v3'
      : 'https://api.flutterwave.com/v3';
  }

  // Generate transaction reference
  generateTxRef() {
    return `benix_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Create payment link for activation
  async createPaymentLink(paymentData) {
    try {
      const {
        amount,
        currency,
        email,
        phone_number,
        name,
        tx_ref,
        redirect_url,
        meta
      } = paymentData;

      const payload = {
        tx_ref,
        amount,
        currency,
        redirect_url,
        customer: {
          email,
          phone_number,
          name
        },
        customizations: {
          title: "BenixSpace Account Activation",
          description: "Payment for account activation",
          logo: "https://your-domain.com/logo.png"
        },
        meta: meta || {}
      };

      const response = await axios.post(
        `${this.baseUrl}/payments`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.secretKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.status === 'success') {
        return {
          success: true,
          payment_link: response.data.data.link,
          tx_ref: tx_ref,
          data: response.data.data
        };
      } else {
        throw new Error(response.data.message || 'Payment link creation failed');
      }
    } catch (error) {
      console.error('Flutterwave payment link creation error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  // Verify payment
  // Verify payment by transaction reference
  async verifyPaymentByTxRef(txRef) {
    try {
      // First, get transactions and find by tx_ref
      const response = await axios.get(
        `${this.baseUrl}/transactions?tx_ref=${txRef}`,
        {
          headers: {
            'Authorization': `Bearer ${this.secretKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.status === 'success' && response.data.data.length > 0) {
        const transaction = response.data.data[0];
        
        return {
          success: true,
          status: transaction.status,
          amount: transaction.amount,
          currency: transaction.currency,
          tx_ref: transaction.tx_ref,
          transaction_id: transaction.id,
          customer: transaction.customer,
          payment_type: transaction.payment_type,
          charged_amount: transaction.charged_amount,
          data: transaction
        };
      } else {
        throw new Error('Transaction not found or verification failed');
      }
    } catch (error) {
      console.error('Flutterwave payment verification by tx_ref error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  // Verify payment by transaction ID
  async verifyPayment(transactionId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/transactions/${transactionId}/verify`,
        {
          headers: {
            'Authorization': `Bearer ${this.secretKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.status === 'success') {
        const transaction = response.data.data;
        
        return {
          success: true,
          status: transaction.status,
          amount: transaction.amount,
          currency: transaction.currency,
          tx_ref: transaction.tx_ref,
          transaction_id: transaction.id,
          customer: transaction.customer,
          payment_type: transaction.payment_type,
          charged_amount: transaction.charged_amount,
          data: transaction
        };
      } else {
        throw new Error(response.data.message || 'Payment verification failed');
      }
    } catch (error) {
      console.error('Flutterwave payment verification error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  // Handle webhook (verify webhook signature)
  verifyWebhookSignature(payload, signature) {
    try {
      const hash = crypto
        .createHmac('sha256', this.secretKey)
        .update(JSON.stringify(payload))
        .digest('hex');
      
      return hash === signature;
    } catch (error) {
      console.error('Webhook signature verification error:', error);
      return false;
    }
  }

  // Get transaction details
  async getTransaction(transactionId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/transactions/${transactionId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.secretKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.status === 'success') {
        return {
          success: true,
          data: response.data.data
        };
      } else {
        throw new Error(response.data.message || 'Failed to get transaction');
      }
    } catch (error) {
      console.error('Flutterwave get transaction error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  // Create inline payment (for embedded payment form)
  createInlinePayment(paymentData) {
    const {
      amount,
      currency,
      email,
      phone_number,
      name,
      tx_ref,
      callback,
      onclose
    } = paymentData;

    return {
      public_key: this.publicKey,
      tx_ref,
      amount,
      currency,
      payment_options: "card,mobilemoney,ussd,bank",
      customer: {
        email,
        phone_number,
        name
      },
      customizations: {
        title: "BenixSpace Account Activation",
        description: "Payment for account activation",
        logo: "https://your-domain.com/logo.png"
      },
      callback,
      onclose
    };
  }

  // Check if Flutterwave is configured
  isConfigured() {
    return !!(this.publicKey && this.secretKey && this.encryptionKey);
  }

  // Get supported currencies
  getSupportedCurrencies() {
    return [
      'RWF', 'USD', 'UGX', 'KES', 'TZS', 'GHS', 'NGN', 'ZAR', 'EUR', 'GBP'
    ];
  }

  // Format amount for display
  formatAmount(amount, currency) {
    const currencySymbols = {
      'RWF': 'RWF ',
      'USD': '$',
      'UGX': 'UGX ',
      'KES': 'KSh ',
      'TZS': 'TSh ',
      'GHS': 'GH₵ ',
      'NGN': '₦',
      'ZAR': 'R ',
      'EUR': '€',
      'GBP': '£'
    };

    const symbol = currencySymbols[currency] || currency + ' ';
    const formattedAmount = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: currency === 'USD' || currency === 'EUR' || currency === 'GBP' ? 2 : 0,
      maximumFractionDigits: currency === 'USD' || currency === 'EUR' || currency === 'GBP' ? 2 : 0
    }).format(amount);

    return `${symbol}${formattedAmount}`;
  }
}

module.exports = FlutterwaveService;
