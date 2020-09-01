require('dotenv').config({ path: `${__dirname}/.env` });
const Fs = require('fs');
const SimpleGit = require('simple-git');
const Axios = require('axios');
const { GraphQLClient } = require('graphql-request');

const FetchCurrenciesQuery = Fs.readFileSync(`${__dirname}/queries/FetchCurrenciesQuery.graphql`, 'utf8');
const FetchStoreOfferPriceQuery = Fs.readFileSync(`${__dirname}/queries/FetchStoreOfferPriceQuery.graphql`, 'utf8');
const FetchStoreOfferPriceByNamespaceQuery = Fs.readFileSync(`${__dirname}/queries/FetchStoreOfferPriceByNamespaceQuery.graphql`, 'utf8');

class Main {
  constructor () {
    this.language = 'en';
    this.countries = process.env.COUNTRIES && process.env.COUNTRIES.split(',').map(c => c.trim()) || [];
    this.namespaces = [];
    this.currencies = {};
    this.perPage = 1000;
    this.trackingStats = {
      timeUnit: 'ms',
    };
    this.databasePath = `${__dirname}/database`;
    
    this.ql = new GraphQLClient('https://graphql.epicgames.com/graphql', {
      headers: {
        Origin: 'https://epicgames.com',
      },
    });

    this.update();
  }

  async fetchNamespaces () {
    if (!process.env.NAMESPACES_URL) {
      throw new Error('No enviroment variable NAMESPACES_URL');
    }
    const { data } = await Axios.get(process.env.NAMESPACES_URL, {
      responseType: 'json',
    });
    this.namespaces = Object.keys(data);
  }

  async update () {
    let checkpointTime;
    
    checkpointTime = Date.now();
    await this.fetchAllElements(FetchCurrenciesQuery, null,
      (result) => {
        return result && result.Catalog && result.Catalog.supportedCurrencies || {};
      },
      (element) => {
        this.currencies[element.code] = element;
      }
    );
    this.trackingStats.fetchStoreCurrencies = Date.now() - checkpointTime;
    Fs.writeFileSync(`${this.databasePath}/currencies.json`, JSON.stringify(this.currencies, null, 2));
    
    checkpointTime = Date.now();
    for (let i = 0; i < this.countries.length; ++i) {
      const country = this.countries[i];
      console.log(`Updating prices for country ${country}...`);
      try { Fs.mkdirSync(`${this.databasePath}/prices/${country}`); } catch {}
      try { Fs.mkdirSync(`${this.databasePath}/prices-history/${country}`); } catch {}
      await this.fetchAllElements(FetchStoreOfferPriceQuery, {
        country,
        locale: this.language,
        sortBy: 'lastModifiedDate',
        sortDir: 'DESC',
      }, (result) => {
        return result && result.Catalog && result.Catalog.searchStore || {};
      }, (offer) => {
        return this.saveOfferPrice(country, offer);
      });
    }
    this.trackingStats.fetchStoreOfferPricesTime = Date.now() - checkpointTime;

    /**
     * Alternative way (worse; not tested in 100%)
     */
    // await this.fetchNamespaces();
    // checkpointTime = Date.now();
    // for (let i = 0; i < this.countries.length; ++i) {
    //   const country = this.countries[i];
    //   for (let x = 0; x < this.namespaces.length; ++x) {
    //     const namespace = this.namespaces[x];
    //     console.log(`Updating offers for country ${country} and namespace ${namespace}...`);
    //     await this.fetchAllElements(FetchStoreOfferPriceByNamespaceQuery, {
    //       namespace,
    //       country,
    //       locale: this.language,
    //     }, (result) => {
    //       return result && result.Catalog && result.Catalog.catalogOffers || {};
    //     }, (offer) => {
    //       return this.saveOfferPrice(country, offer);
    //     });
    //   }
    // }
    // this.trackingStats.fetchStoreOffersByNamespaceTime = Date.now() - checkpointTime;

    checkpointTime = Date.now();
    this.index();
    this.trackingStats.indexTime = Date.now() - checkpointTime;
    
    this.trackingStats.lastUpdate = Date.now();
    this.trackingStats.lastUpdateString = (new Date(this.trackingStats.lastUpdate)).toISOString();

    await this.sync();
  }

  index () {
    console.log('Indexing...');
    const promotions = {};
    
    for (let i = 0; i < this.countries.length; ++i) {
      const country = this.countries[i];
      const pricesPath = `${this.databasePath}/prices/${country}`;
      Fs.readdirSync(pricesPath).forEach((fileName) => {
        if (fileName.substr(-5) !== '.json') return;
        try {
          const offer = JSON.parse(Fs.readFileSync(`${pricesPath}/${fileName}`));
          if (
            offer.price
            && offer.price.totalPrice
            && offer.price.totalPrice.originalPrice > 0
            && offer.price.totalPrice.discountPrice < offer.price.totalPrice.originalPrice
          ) {
            promotions[offer.id] = [
              offer.price.totalPrice.discountPrice,
              offer.price.totalPrice.originalPrice,
              Math.floor((100 - offer.price.totalPrice.discountPrice / offer.price.totalPrice.originalPrice * 100) * 100) / 100,
            ];
          }
        } catch (error) {
          console.error(error);
        }
      });
      Fs.writeFileSync(`${this.databasePath}/promotions/${country}.json`, JSON.stringify(promotions));
    }
    
  }

  async sync () {
    if (!process.env.GIT_REMOTE) return;
    console.log('Syncing with repo...');
    const git = SimpleGit({
      baseDir: __dirname,
      binary: 'git',
    });
    await git.addConfig('hub.protocol', 'https');
    await git.checkoutBranch('master');
    await git.add([`${this.databasePath}/.`]);
    const status = await git.status();
    const changesCount = status.created.length + status.modified.length + status.deleted.length + status.renamed.length;
    if (changesCount === 0) return;
    Fs.writeFileSync(`${this.databasePath}/tracking-stats.json`, JSON.stringify(this.trackingStats, null, 2));
    await git.add([`${this.databasePath}/tracking-stats.json`]);
    const commitMessage = `Update - ${new Date().toISOString()}`;
    await git.commit(commitMessage);
    await git.removeRemote('origin');
    await git.addRemote('origin', process.env.GIT_REMOTE);
    await git.push(['-u', 'origin', 'master']);
    console.log(`Changes has commited to repo with message ${commitMessage}`);
  }
  
  saveOfferPrice (country, offer) {
    if (!offer.price) return;
    try {
      Fs.writeFileSync(`${this.databasePath}/prices/${country}/${offer.id}.json`, JSON.stringify(offer, null, 2));
    } catch (error) {
      console.log(`${offer.id} = ERROR`);
      console.error(error);
      console.log(JSON.stringify(offer, null, 2));
    }
    try {
      const pricesHistoryPath = `${this.databasePath}/prices-history/${country}/${offer.id}.json`;
      let pricesHistory = [];
      if (Fs.existsSync(pricesHistoryPath)) {
        pricesHistory = JSON.parse(Fs.readFileSync(pricesHistoryPath));
      }
      const latestPrice = pricesHistory[0] && typeof pricesHistory[0][1] !== 'undefined' ? pricesHistory[0][1] : null;
      const currentPrice = offer.price.totalPrice.discountPrice;
      if (latestPrice === null || latestPrice !== currentPrice) {
        pricesHistory.unshift([
          (new Date()).toISOString(),
          currentPrice,
        ]);
      }
      Fs.writeFileSync(pricesHistoryPath, JSON.stringify(pricesHistory));
    } catch (error) {
      console.log(`${offer.id} = CANNOT UPDATE PRICE HISTORY`);
      console.error(error);
      console.log(JSON.stringify(offer, null, 2));
    }
  }

  sleep (time) {
    return new Promise((resolve) => {
      const sto = setTimeout(() => {
        clearTimeout(sto);
        resolve();
      }, time);
    });
  }

  async fetchAllElements (query, params, resultSelector, saveFunction) {
    let paging = {};
    do {
      const result = await this.fetchElements(query, params, resultSelector, paging.start, paging.count || this.perPage);
      paging = result.paging;
      paging.start += paging.count;
      for (let i = 0; i < result.elements.length; ++i) {
        const element = result.elements[i];
        saveFunction(element);
      }
      await this.sleep(1000);
    } while (paging.start - this.perPage < paging.total - paging.count);
  }

  async fetchElements (query, params, resultSelector, start = 0, count = 1000) {
    try {
      let result = await this.ql.request(query, {
        ...params,
        start,
        count,
      });
      result = resultSelector(result);
      return result;
    } catch (error) {
      if (error.response) {
        if (error.response.data) {
          const result = resultSelector(error.response.data);
          if (result && result.elements && result.paging) {
            return result;
          }
        }
        console.log(JSON.stringify(error.response, null, 2));
        console.log('Next attempt in 1s...');
        await this.sleep(5000);
        return this.fetchElements(...arguments);
      } else {
        throw new Error(error);
      }
    }
  }
}

module.exports = new Main();
