/*

File cache
==========

Copyright (c) 2021 Dannii Willis
MIT licenced
https://github.com/iftechfoundation/ifarchive-unbox

*/

/*
This cache will keep track of both the number of entries, and the total download size, evicting the least recently used when either goes over the limit
When the ArchiveIndex sees an update, it will purge any outdated entries
*/

import child_process from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import util from 'util'

import {SUPPORTED_FORMATS, escape_shell_single_quoted} from './common.js'

const exec = util.promisify(child_process.exec)
const execFile = util.promisify(child_process.execFile)

class CacheEntry {
    constructor (contents, date, size, type) {
        this.contents = contents
        this.date = date
        this.size = size
        this.type = type
    }
}

export default class FileCache {
    constructor(data_dir, options) {
        this.cache = new Map()
        this.cache_dir = path.join(data_dir, 'cache')
        this.index = null
        this.lru = []
        this.max_buffer = options.cache.max_buffer
        this.max_entries = options.cache.max_entries
        this.max_size = options.cache.max_size
        this.options = options
        this.size = 0
    }

    async init() {
        // Get all the files currently in the cache directory
        const files = await fs.readdir(this.cache_dir)

        // Add them into the cache
        await Promise.all(files.map(async file => {
            const file_path = path.join(this.cache_dir, file)
            const parts = /(\w+)\.(.+)/.exec(file)
            const hash = parseInt(parts[1], 36)
            const stat = await fs.stat(file_path)
            const date = +stat.mtime
            const size = stat.size
            const type = parts[2]
            const contents = await this.list_contents(file_path, type)
            const entry = new CacheEntry(contents, date, size, type)
            this.cache.set(hash, entry)
            this.lru.push(hash)
            this.size += size
        }))
    }

    // Download and set up a cache entry
    async download(hash) {
        // Download the file with curl
        const url = `https://${this.options.archive_domain}/if-archive/${this.index.hash_to_path.get(hash)}`
        const type = SUPPORTED_FORMATS.exec(url)[1].toLowerCase()
        const cache_path = this.file_path(hash, type)
        const details = await execFile('curl', [encodeURI(url), '-o', cache_path, '-s', '-S', '-D', '-'])
        if (details.stderr) {
            throw new Error(`curl error: ${details.stderr}`)
        }

        // Parse the date
        const date_header = /last-modified:\s+\w+,\s+(\d+\s+\w+\s+\d+)/.exec(details.stdout)
        if (!date_header) {
            throw new Error('Could not parse last-modified header')
        }
        const date = new Date(`${date_header[1]} UTC`)

        // Reset the file's date
        await fs.utimes(cache_path, date, date)

        // Get the file size
        const size = (await fs.stat(cache_path)).size
        this.size += size

        // Get the files inside
        const contents = await this.list_contents(cache_path, type)

        // Update the cache, replacing the promise entry with a resolved entry object
        const entry = new CacheEntry(contents, +date, size, type)
        this.cache.set(hash, entry)

        // Check the cache size
        if (this.size > this.max_size) {
            await this.evict()
        }
        return entry
    }

    // Evict old entries to make space for new ones
    // This checks both the number of entries and their total size. (Size is the total size of zip files, not the total unpacked size.) We discard old entries as long as we're over either limit.
    async evict() {
        while (this.lru.length > this.max_entries || this.size > this.max_size) {
            const hash = this.lru.pop()
            const entry = this.cache.get(hash)
            this.cache.delete(hash)
            this.size -= entry.size
            await fs.rm(this.file_path(hash, entry.type))
        }
    }

    // Return the path where the given Archive file is downloaded to.
    // (HASH.zip, HASH.tar.gz, HASH.tgz in the cache dir.)
    file_path(hash, type) {
        return path.join(this.cache_dir, `${hash.toString(36)}.${type}`)
    }

    // Get a file out of the cache, or download it
    // This may immediately return the file entry, or it may return a promise that waits for it to be downloaded, but `await`ing the result will handle both seamlessly.
    async get(hash) {
        if (this.cache.has(hash)) {
            this.hit(hash)
            return this.cache.get(hash)
        }

        // We add the promise to the cache even if it's pending. That way, future callers will get the same promise and will wait in parallel on it.
        // (It would be bad if two callers got different promises to the same hash, which then started to download to the same location.)
        this.lru.unshift(hash)
        const entry_promise = this.download(hash)
        this.cache.set(hash, entry_promise)

        // Check the cache length
        if (this.lru.length > this.max_entries) {
            await this.evict()
        }
        return entry_promise
    }

    // Extract a file from a zip, returning a buffer
    async get_file(hash, file_path, type) {
        const zip_path = this.file_path(hash, type)
        if (type === 'tar.gz' || type === 'tgz') {
            const results = await execFile('tar', ['-xOzf', zip_path, file_path], {encoding: 'buffer', maxBuffer: this.max_buffer})
            if (results.stderr.length) {
                throw new Error(`tar error: ${results.stderr.toString()}`)
            }
            return results.stdout
        }
        else if (type === 'zip') {
            const results = await execFile('unzip', ['-p', zip_path, file_path], {encoding: 'buffer', maxBuffer: this.max_buffer})
            if (results.stderr.length) {
                throw new Error(`unzip error: ${results.stderr.toString()}`)
            }
            return results.stdout
        }
        else {
            throw new Error('Other archive format not yet supported')
        }
    }

    // Get a file from a zip, returning a stream
    get_file_stream(hash, file_path, type) {
        const zip_path = this.file_path(hash, type)
        if (type === 'tar.gz' || type === 'tgz') {
            const child = child_process.spawn('tar', ['-xOzf', zip_path, file_path])
            return child.stdout
        }
        else if (type === 'zip') {
            const child = child_process.spawn('unzip', ['-p', zip_path, file_path])
            return child.stdout
        }
        else {
            throw new Error('Other archive format not yet supported')
        }
    }

    // Run file on an extracted file
    async get_file_type(hash, file_path, type) {
        const zip_path = this.file_path(hash, type)
        if (type === 'tar.gz' || type === 'tgz') {
            const results = await exec(`tar -xOzf ${zip_path} '${escape_shell_single_quoted(file_path)}' | file -i -`)
            if (results.stderr.length) {
                throw new Error(`tar|file error: ${results.stderr.toString()}`)
            }
            // Trim '/dev/stdin:'
            return results.stdout.trim().substring(12)
        }
        else if (type === 'zip') {
            const results = await exec(`unzip -p ${zip_path} '${escape_shell_single_quoted(file_path)}' | file -i -`)
            if (results.stderr.length) {
                throw new Error(`unzip|file error: ${results.stderr.toString()}`)
            }
            // Trim '/dev/stdin:'
            return results.stdout.trim().substring(12)
        }
        else {
            throw new Error('Other archive format not yet supported')
        }
    }

    // Update the LRU list
    hit(hash) {
        const oldpos = this.lru.indexOf(hash)
        this.lru.splice(oldpos, 1)
        this.lru.unshift(hash)
    }

    // List the contents of a zip
    async list_contents(path, type) {
        let output
        if (type === 'tar.gz' || type === 'tgz') {
            const tarball_contents = await execFile('tar', ['-tf', path])
            if (tarball_contents.stderr) {
                throw new Error(`tar error: ${tarball_contents.stderr}`)
            }
            output = tarball_contents.stdout
        }
        else if (type === 'zip') {
            const zip_contents = await execFile('unzip', ['-Z1', path])
            if (zip_contents.stderr) {
                throw new Error(`unzip error: ${zip_contents.stderr}`)
            }
            output = zip_contents.stdout
        }
        else {
            throw new Error('Other archive format not yet supported')
        }
        return output.trim().split('\n').filter(line => !line.endsWith('/')).sort()
    }

    // Purge out of date files
    async purge(data) {
        for (const [hash, entry] of this.cache) {
            if (entry instanceof CacheEntry && entry.date !== data.get(hash))
            {
                console.log(`Removing outdated cache file ${hash.toString(36)}.${entry.type} (${this.index.hash_to_path.get(hash)})`)
                this.cache.delete(hash)
                const oldpos = this.lru.indexOf(hash)
                this.lru.splice(oldpos, 1)
                this.size -= entry.size
                await fs.rm(this.file_path(hash, entry.type))
            }
        }

        // Check that we have the right number of cache entries
        const files = await fs.readdir(this.cache_dir)
        if (this.cache.size !== files.length || this.cache.size !== this.lru.length) {
            console.warn(`Cache has inconsistent data: ${this.cache.size} entries, ${this.lru.length} LRU entries, ${files.length} files`)
        }
    }
}
