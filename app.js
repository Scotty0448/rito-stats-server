var dotenv = require('dotenv')
var fs = require('fs')
var readline = require('readline')
var app = require('express')()
var cors = require('cors'); app.use(cors())
var http = require('http').Server(app)
var io = require('socket.io')(http, {
  cors: {
    origin: "https://stats.ritocoin.org",
    methods: ["GET", "POST"]
  }
})
var axios = require('axios')
var zmq = require('zeromq')
var RpcClient = require('ravend-rpc')

dotenv.config()

var rpc = new RpcClient({
  protocol: 'http',
  user:     process.env.RPC_USER,
  pass:     process.env.RPC_PASS,
  host:     process.env.RPC_HOST,
  port:     process.env.RPC_PORT
})

const ZMQ_URI             = process.env.ZMQ_URI
const BURN_ADDRESSES      = process.env.BURN_ADDRESSES.split(',').map(a => a.trim())
const DEV_FUND_ADDRESS    = process.env.DEV_FUND_ADDRESS
const HISTORY_FILENAME    = process.env.HISTORY_FILENAME

var daily_info          = {}
var current_block_info  = {'height':0, 'time':0, 'networkhashps':0, 'difficulty':0, 'reward':0, 'dev_fund':0, 'tx_fee':0, 'total_rewards':0, 'total_dev_funds':0, 'total_tx_fees':0, 'total_burned':0}
var current_price_info  = {}

// -- RPC Functions -- //

function getBlockCount() {
  return new Promise((resolve, reject) =>
    rpc.getBlockCount((err, ret) => {
      err ? reject(err) : resolve(ret.result)
    })
  )
}

function getBlockHash(block_number) {
  return new Promise((resolve, reject) =>
    rpc.getBlockHash(block_number, (err, ret) => {
      err ? reject(err) : resolve(ret.result)
    })
  )
}

function getMiningDisbursements(block) {
  return new Promise((resolve, reject) =>
    rpc.getRawTransaction(block.tx[0], 2, (err, ret) => {
      if (err) {
        reject(err)
      } else {
        var reward = 0
        var dev_fund = 0
        var tx_fee = 0
        for (i = 0; i < ret.result.vout.length; i++) {
          var v = ret.result.vout[i]
          if ((v.scriptPubKey.addresses != undefined) && (v.scriptPubKey.addresses[0] == DEV_FUND_ADDRESS)) {
            dev_fund += v.value
          } else if (v.value > 0) {
            reward += Math.floor(v.value)
            tx_fee += +(v.value - Math.floor(v.value)).toFixed(8)
          }
        }
        resolve([reward, dev_fund, tx_fee])
      }
    })
  )
}

function getMiningInfo() {
  return new Promise((resolve, reject) =>
    rpc.getMiningInfo((err, ret) => {
      err ? reject(err) : resolve(ret.result)
    })
  )
}

function getTotalBurned() {
  return new Promise((resolve, reject) =>
    rpc.getaddressbalance(JSON.stringify({'addresses':BURN_ADDRESSES}), (err, ret) => {
      err ? reject(err) : resolve(ret.result.balance)
    })
  )
}

function getBlockInfo(block_hash) {
  return new Promise((resolve, reject) =>
    rpc.getBlock(block_hash, (err, ret) => {
      if (err) {
        reject(err)
      } else {
        block = ret.result
        getMiningDisbursements(block)
          .then(([reward, dev_fund, tx_fee]) => {
            var info = {}
            info.height     = block.height
            info.time       = block.time
            info.difficulty = +Number(block.difficulty).toFixed(3)
            info.reward     = Math.floor(reward)
            info.dev_fund   = dev_fund
            info.tx_fee     = tx_fee
            resolve(info)
          })
          .catch(err => reject(err))
      }
    })
  )
}

// -- Price Functions -- //

function getBTCPrice() {
  return new Promise((resolve, reject) =>
    axios.get('https://cex.io/api/ticker/BTC/USD')
      .then(ret => resolve(Number(ret.data.last)))
      .catch(err => reject(err))
  )
}

function getPrices() {
  return new Promise((resolve, reject) =>
    axios.get('https://api.coingecko.com/api/v3/coins/rito/tickers')
      .then(ret => {
        var tickers = ret.data.tickers.filter(ticker => {return ticker.target=='BTC' && ticker.volume > 0 && ticker.market.name != 'CITEX' && ticker.market.name != 'CryptoBridge'})
        var prices = tickers.map(ticker => {return {name:ticker.market.name, price:ticker.last, volume:ticker.volume}})
        resolve(prices.sort((a,b) => b.volume - a.volume))
      })
      .catch(err => reject(err))
  )
}

function getPriceInfo() {
  return new Promise((resolve, reject) => {
    price_info = {}
    Promise.all([
      getBTCPrice(),
      getPrices()
    ])
    .then(values => {
      [price_info.btc, price_info.rito] = values
      resolve(price_info)
    })
    .catch(err => reject(err))
  })
}

// -- Utilities -- //

function handleError(err) {
  console.log(err.message)
}

function appendToHistoryFile(block_info) {
  fs.appendFileSync(HISTORY_FILENAME, JSON.stringify(block_info)+'\n', (err, data) => {
    if (err) handleError(err)
  })
}

function addToDailyInfo(block_info) {
  var date = new Date(block_info.time * 1000).toISOString().slice(0,10)
  if (daily_info[date] === undefined) {
    daily_info[date] = {'blocks':1, 'total_difficulty':+(+block_info.difficulty).toFixed(3), 'total_rewards':block_info.reward}
  } else {
    daily_info[date].blocks += 1
    daily_info[date].total_difficulty = +(daily_info[date].total_difficulty+block_info.difficulty).toFixed(3)
    daily_info[date].total_rewards += block_info.reward
  }
}

function latest_daily_info() {
  var info = {}
  var date = new Date(current_block_info.time * 1000).toISOString().slice(0,10)
  info[date] = daily_info[date]
  return info
}

// -- Initialization -- //

function initializeSocketComm() {
  io.on('connection', socket => {
    socket.on('request', msg => {
      switch (msg) {
        case 'currentBlockInfo':
          socket.emit('currentBlockInfo', current_block_info)
          break
        case 'currentPriceInfo':
          socket.emit('currentPriceInfo', current_price_info)
          break
        case 'fullDailyInfo':
          socket.emit('fullDailyInfo', daily_info)
          break
      }
    })
    socket.on('disconnect', () => {
    })
  })
}

function pollPriceInfoPeriodically() {
  setInterval(() => {
    getPriceInfo()
      .then(price_info => {
        current_price_info = price_info
        io.emit('currentPriceInfo', current_price_info)
      })
      .catch(err => handleError(err))
  }, 5000)
}

function processOldBlocks(filename) {
  return new Promise((resolve, reject) => {
    try {
      var block_info
      var total_rewards = 0
      var total_dev_funds = 0
      var total_tx_fees = 0
      var stats = fs.stat(filename, (err,stats) => {
        if (stats && stats.isFile()) {
          var lineReader = readline.createInterface({
            input: require('fs').createReadStream(filename)
          })
          lineReader.on('line', line => {
            block_info = JSON.parse(line)
            addToDailyInfo(block_info)
            total_rewards   += Math.round(block_info.reward * 100000000)
            total_dev_funds += Math.round(block_info.dev_fund * 100000000)
            total_tx_fees   += Math.round(block_info.tx_fee * 100000000)
          })
          lineReader.on('close', () => {
            Object.assign(current_block_info, block_info)
            current_block_info.total_rewards   = total_rewards
            current_block_info.total_dev_funds = total_dev_funds
            current_block_info.total_tx_fees   = total_tx_fees
            getTotalBurned()
              .then(burned => {
                current_block_info.total_burned = burned
                io.emit('currentBlockInfo', current_block_info)
                io.emit('currentPriceInfo', current_price_info)
                io.emit('fullDailyInfo', daily_info)
                resolve()
              })
              .catch(err => reject(err))
          })
        } else {
          resolve()
        }
      })
    } catch(err) {reject(err)}
  })
}

function processNewBlock(block_number) {
  return new Promise((resolve, reject) =>
    getBlockHash(block_number)
      .then(block_hash => {
        getBlockInfo(block_hash)
          .then(block_info => {
            appendToHistoryFile(block_info)
            addToDailyInfo(block_info)
            Object.assign(current_block_info, block_info)
            current_block_info.total_rewards   += Math.round(block_info.reward * 100000000)
            current_block_info.total_dev_funds += Math.round(block_info.dev_fund * 100000000)
            current_block_info.total_tx_fees   += Math.round(block_info.tx_fee * 100000000)
            io.emit('currentBlockInfo', current_block_info)
            resolve()
          })
          .catch(err => reject(err))
      })
      .catch(err => reject(err))
  )
}

function processNewBlocks() {
  return new Promise((resolve, reject) =>
    getBlockCount()
      .then(async block_count => {
        if (block_count > current_block_info.height) {
          for (block_number = current_block_info.height + 1; block_number <= block_count; block_number++) {
            await processNewBlock(block_number).catch(err => handleError(err))
          }
          resolve(true)
        } else {
          getMiningInfo()
            .then(mining_info => {
              current_block_info.networkhashps = Math.round(mining_info.networkhashps)
              io.emit('currentBlockInfo', current_block_info)
              io.emit('currentPriceInfo', current_price_info)
              io.emit('fullDailyInfo', daily_info)
              resolve(false)
            })
            .catch(err => reject(err))
        }
      })
      .catch(err => reject(err))
  )
}

function initializeZMQcomm() {
  var zmq_socket = zmq.socket('sub')
  zmq_socket.connect(ZMQ_URI)
  zmq_socket.subscribe('hashblock')
  zmq_socket.on('message', (topic, message) => {
    if (topic.toString() == 'hashblock') {
      getBlockInfo(message.toString('hex'))
        .then(block_info => {
          appendToHistoryFile(block_info)
          Object.assign(current_block_info, block_info)
          current_block_info.total_rewards   += Math.round(block_info.reward * 100000000)
          current_block_info.total_dev_funds += Math.round(block_info.dev_fund * 100000000)
          current_block_info.total_tx_fees   += Math.round(block_info.tx_fee * 100000000)
          getTotalBurned()
            .then(burned => {
              current_block_info.total_burned = burned
              getMiningInfo()
                .then(mining_info => {
                  current_block_info.networkhashps = Math.round(mining_info.networkhashps)
                  addToDailyInfo(block_info)
                  io.emit('currentBlockInfo', current_block_info)
                  io.emit('newDailyInfo', latest_daily_info())
                })
                .catch(err => handleError(err))
            })
            .catch(err => handleError(err))
        })
        .catch(err => handleError(err))
    }
  })
}

async function initialize() {
  try {
    initializeSocketComm()
    pollPriceInfoPeriodically()
    await processOldBlocks(HISTORY_FILENAME)
    while (await processNewBlocks()) { }
    initializeZMQcomm()
    io.emit('reload')
  } catch(err) {
    handleError(err)
  }
}

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html')
})

app.get('/prices', (req, res) => {
  getPriceInfo()
    .then(price_info => {
      res.send(200, price_info)
    })
    .catch(err => handleError(err))
})

app.get('/api/supply', (req, res) => {
  var supply = current_block_info.total_rewards + current_block_info.total_dev_funds - current_block_info.total_burned
  res.send(200, Math.round(supply/100000000))
})

http.listen(8002, () => {
  initialize()
})
