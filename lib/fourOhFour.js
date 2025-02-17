'use strict'

const FindMyWay = require('find-my-way')

const Reply = require('./reply')
const Request = require('./request')
const Context = require('./context')
const {
  kRoutePrefix,
  kCanSetNotFoundHandler,
  kFourOhFourLevelInstance,
  kFourOhFourContext,
  kHooks
} = require('./symbols.js')
const { lifecycleHooks } = require('./hooks')
const { buildErrorHandler } = require('./error-handler.js')
const fourOhFourContext = {
  config: {
  },
  onSend: [],
  onError: [],
  errorHandler: buildErrorHandler()
}

/**
 * Each fastify instance have a:
 * kFourOhFourLevelInstance: point to a fastify instance that has the 404 handler setted
 * kCanSetNotFoundHandler: bool to track if the 404 handler has already been set
 * kFourOhFour: the singleton instance of this 404 module
 * kFourOhFourContext: the context in the reply object where the handler will be executed
 */
function fourOhFour (options) {
  const { logger, genReqId, disableRequestLogging } = options

  // 404 router, used for handling encapsulated 404 handlers
  const router = FindMyWay({ onBadUrl, defaultRoute: fourOhFourFallBack })

  return { router, setNotFoundHandler, setContext, arrange404 }

  function arrange404 (instance) {
    // Change the pointer of the fastify instance to itself, so register + prefix can add new 404 handler
    instance[kFourOhFourLevelInstance] = instance
    instance[kCanSetNotFoundHandler] = true
  }

  function basic404 (request, reply) {
    const { url, method } = request.raw
    const message = `Route ${method}:${url} not found`
    request.log.info(message)
    reply.code(404).send({
      message,
      error: 'Not Found',
      statusCode: 404
    })
  }

  function onBadUrl (path, req, res) {
    const { url, method } = req
    const message = `Route ${method}:${url} not found`
    const body = `{"error":"Not Found","message":"${message}","statusCode":404}`

    // simulate normal route logging
    if (!disableRequestLogging) {
      const id = genReqId(req)
      const childLogger = logger.child({ reqId: id })
      childLogger.info({ req }, 'incoming request')
      childLogger.info({ req }, message)
    }

    res.writeHead(404, {
      'Content-Type': 'application/json',
      'Content-Length': body.length
    })
    res.end(body)
  }

  function setContext (instance, context) {
    const _404Context = Object.assign({}, instance[kFourOhFourContext])
    _404Context.onSend = context.onSend
    context[kFourOhFourContext] = _404Context
  }

  function setNotFoundHandler (opts, handler, avvio, routeHandler) {
    // First initialization of the fastify root instance
    if (this[kCanSetNotFoundHandler] === undefined) {
      this[kCanSetNotFoundHandler] = true
    }
    if (this[kFourOhFourContext] === undefined) {
      this[kFourOhFourContext] = null
    }

    const _fastify = this
    const prefix = this[kRoutePrefix] || '/'

    if (this[kCanSetNotFoundHandler] === false) {
      throw new Error(`Not found handler already set for Fastify instance with prefix: '${prefix}'`)
    }

    if (typeof opts === 'object') {
      if (opts.preHandler) {
        if (Array.isArray(opts.preHandler)) {
          opts.preHandler = opts.preHandler.map(hook => hook.bind(_fastify))
        } else {
          opts.preHandler = opts.preHandler.bind(_fastify)
        }
      }

      if (opts.preValidation) {
        if (Array.isArray(opts.preValidation)) {
          opts.preValidation = opts.preValidation.map(hook => hook.bind(_fastify))
        } else {
          opts.preValidation = opts.preValidation.bind(_fastify)
        }
      }
    }

    if (typeof opts === 'function') {
      handler = opts
      opts = undefined
    }
    opts = opts || {}

    if (handler) {
      this[kFourOhFourLevelInstance][kCanSetNotFoundHandler] = false
      handler = handler.bind(this)
    } else {
      handler = basic404
    }

    this.after((notHandledErr, done) => {
      _setNotFoundHandler.call(this, prefix, opts, handler, avvio, routeHandler)
      done(notHandledErr)
    })
  }

  function _setNotFoundHandler (prefix, opts, handler, avvio, routeHandler) {
    const context = new Context({
      schema: opts.schema,
      handler,
      config: opts.config || {},
      server: this
    })

    avvio.once('preReady', () => {
      const context = this[kFourOhFourContext]
      for (const hook of lifecycleHooks) {
        const toSet = this[kHooks][hook]
          .concat(opts[hook] || [])
          .map(h => h.bind(this))
        context[hook] = toSet.length ? toSet : null
      }
    })

    if (this[kFourOhFourContext] !== null && prefix === '/') {
      Object.assign(this[kFourOhFourContext], context) // Replace the default 404 handler
      return
    }

    this[kFourOhFourLevelInstance][kFourOhFourContext] = context

    router.all(prefix + (prefix.endsWith('/') ? '*' : '/*'), routeHandler, context)
    router.all(prefix, routeHandler, context)
  }

  function fourOhFourFallBack (req, res) {
    // if this happen, we have a very bad bug
    // we might want to do some hard debugging
    // here, let's print out as much info as
    // we can
    const id = genReqId(req)
    const childLogger = logger.child({ reqId: id })

    childLogger.info({ req }, 'incoming request')

    const request = new Request(id, null, req, null, childLogger, fourOhFourContext)
    const reply = new Reply(res, request, childLogger)

    request.log.warn('the default handler for 404 did not catch this, this is likely a fastify bug, please report it')
    request.log.warn(router.prettyPrint())
    reply.code(404).send(new Error('Not Found'))
  }
}

module.exports = fourOhFour
