/*

IF Archive Unboxing server
==========================

Copyright (c) 2021 Dannii Willis
MIT licenced
https://github.com/iftechfoundation/ifarchive-unbox

*/

import path from 'path'
import Koa from 'koa'

import * as templates from './templates.js'

const PATH_PARTS = /^\/([0-9a-zA-Z]+)\/?(.*)$/
const UNSAFE_FILES = /\.(html?|svg)$/i
const VALID_ORIGINS = /^https?:\/\/(mirror\.|www\.)?ifarchive\.org\//

export default class UnboxApp {
    constructor(options, cache, index) {
        this.cache = cache
        this.index = index
        this.options = options

        const domain = options.domain

        this.app = new Koa()
        this.app.subdomainOffset = domain.split('.').length

        // Add the layers

        // Catch errors
        this.app.use(async (ctx, next) => {
            try {
                await next()
            }
            catch (err) {
                ctx.status = err.statusCode || err.status || 500
                ctx.body = templates.wrapper(templates.error(err), '')
                if (ctx.status !== 400) {
                    ctx.app.emit('error', err, ctx)
                }
            }
        })

        // Redirect to subdomains
        if (domain && options.subdomains) {
            this.app.use(async (ctx, next) => {
                const path = ctx.path
                const subdomain_count = ctx.subdomains.length

                // Too many subdomains
                if (subdomain_count > 1) {
                    ctx.throw(400, 'Too many subdomains')
                }

                // Safe file on non-subdomain
                if (subdomain_count === 1 && !UNSAFE_FILES.test(path)) {
                    ctx.status = 301
                    ctx.redirect(`//${domain}${path}`)
                    return
                }

                // Unsafe file on main domain
                if (subdomain_count === 0 && UNSAFE_FILES.test(path)) {
                    const path_parts = PATH_PARTS.exec(path)
                    if (path_parts) {
                        ctx.status = 301
                        ctx.redirect(`//${path_parts[1]}.${domain}${path}`)
                        return
                    }
                }

                await next()
            })
        }

        // Serve a proxy.pac file
        if (domain && options.serve_proxy_pac) {
            this.app.use(async (ctx, next) => {
                if (ctx.path === '/proxy.pac') {
                    // serve a proxy.pac file for testing *.localhost wildcard domains
                    ctx.status = 200
                    ctx.type = 'application/x-ns-proxy-autoconfig'
                    ctx.body = `function FindProxyForURL(url, host) { if (shExpMatch(host, "*${domain}")) { return "PROXY ${domain}:80" } return "DIRECT" }`
                    return
                }
                await next()
            })
        }

        // And the main handler
        this.app.use(this.handler.bind(this))
    }

    listen(port) {
        console.log(`Starting IF Archive Unboxing server on port ${port}`)
        this.app.listen(port)
    }

    async handler(ctx) {
        const request_path = ctx.path
        const query = ctx.query

        // Solve CORS issues
        ctx.set('Access-Control-Allow-Origin', '*')

        // Front page
        if (request_path === '/') {
            if (!query.url) {
                ctx.body = templates.wrapper(templates.form(), '')
                return
            }

            // Normalise URLs
            if (!VALID_ORIGINS.test(query.url)) {
                ctx.throw(400, `Sorry, we don't support files from outside the IF Archive`)
            }

            const file_path = query.url.replace(VALID_ORIGINS, '').replace(/^if-archive\//, '')
            const hash = this.index.path_to_hash.get(file_path)
            if (!hash) {
                ctx.throw(400, `Unknown file: ${query.url}`)
            }

            const details = await this.cache.get(hash)

            // Search for a file
            if (query.find) {
                const candidates = details.contents.filter(file => file.endsWith(query.find))
                if (candidates.length > 1) {
                    ctx.throw(400, 'Multiple matching files')
                }
                if (candidates.length === 0) {
                    ctx.throw(400, 'No matching file')
                }
                ctx.status = 301
                ctx.redirect(`/${hash.toString(36)}/${candidates[0]}`)
                return
            }

            // Send and check the Last-Modified/If-Modified-Since headers
            ctx.status = 200
            ctx.lastModified = new Date(details.date)
            if (ctx.fresh) {
                ctx.status = 304
                return
            }

            // Show the list of files
            ctx.body = templates.wrapper(templates.list(file_path, hash.toString(36), details.contents), `${path.basename(file_path)} - `)
            return
        }

        // Trying to load a file from a zip
        const path_parts = PATH_PARTS.exec(request_path)
        if (!path_parts) {
            ctx.throw(400, 'This is not a valid file')
        }
        const hash_string = path_parts[1]
        const hash = parseInt(hash_string, 36)
        const zip_path = this.index.hash_to_path.get(hash)
        if (!zip_path) {
            ctx.throw(400, `Unknown file hash: ${hash_string}`)
        }

        // Redirect folder views back to the index
        const file_path = decodeURIComponent(path_parts[2])
        if (file_path === '' || file_path.endsWith('/')) {
            ctx.status = 301
            ctx.redirect(`/?url=https://ifarchive.org/if-archive/${zip_path}`)
            return
        }

        const details = await this.cache.get(hash)
        if (details.contents.indexOf(file_path) < 0) {
            ctx.throw(400, `${zip_path} does not contain file ${file_path}`)
        }

        // Check for non-matching subdomain
        if (ctx.subdomains[0] !== hash_string) {
            ctx.throw(400, `Incorrect subdomain`)
        }

        // Send and check the Last-Modified/If-Modified-Since headers
        ctx.status = 200
        ctx.lastModified = new Date(details.date)
        if (ctx.fresh) {
            ctx.status = 304
            return
        }

        // Pipe the unzipped file to body
        ctx.type = path.extname(file_path)
        ctx.body = this.cache.get_file(hash, file_path, details.type)
    }
}