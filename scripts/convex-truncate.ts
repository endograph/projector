import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Parse table names from convex/schema.ts by looking for defineTable calls.
 * Looks for schema.ts relative to the current working directory.
 * Matches patterns like: `tableName: defineTable({`
 */
async function getTablesFromSchema(): Promise<string[]> {
    const schemaPath = join(process.cwd(), 'convex', 'schema.ts')
    const schemaContent = await readFile(schemaPath, 'utf-8')

    // Match table names: looks for `identifier: defineTable(`
    // This handles patterns like:
    //   todos: defineTable({
    //   machineTurns: defineTable({
    const tablePattern = /^\s*(\w+):\s*defineTable\s*\(/gm
    const tables: string[] = []

    let match
    while ((match = tablePattern.exec(schemaContent)) !== null) {
        if (match[1]) {
            tables.push(match[1])
        }
    }

    if (tables.length === 0) {
        throw new Error('No tables found in schema.ts. Check the file format.')
    }

    return tables
}

function usageAndExit(tables?: string[]): never {
    console.log('Usage: tsx scripts/convex-truncate.ts <tableName> [--file <path>]')
    console.log('       tsx scripts/convex-truncate.ts --all')
    console.log('')
    console.log('Replaces the contents of the Convex table with the data from an empty JSON Lines file.')
    console.log('If --file is provided, that file will be used instead of generating a temporary file.')
    console.log('If --all is provided, truncates all tables' + (tables ? ': ' + tables.join(', ') : ' defined in schema.ts'))
    process.exit(1)
}

function runConvexImport(tableName: string, filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn('bunx', ['convex', 'import', '--replace', '--yes', '--table', tableName, filePath], {
            stdio: 'inherit',
        })

        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0) {
                resolve()
            } else {
                reject(new Error(`Convex import exited with code ${code}`))
            }
        })
    })
}

async function truncateTable(tableName: string, emptyFilePath: string): Promise<void> {
    console.log(`🔄 Truncating Convex table "${tableName}"...`)
    await runConvexImport(tableName, emptyFilePath)
    console.log(`✅ Table "${tableName}" successfully cleared.`)
}

async function main() {
    const args = process.argv.slice(2)

    // Parse tables from schema for --all and for usage display
    let allTables: string[] | undefined
    try {
        allTables = await getTablesFromSchema()
    } catch (error) {
        // If we can't read the schema, we can still truncate individual tables
        if (args.includes('--all')) {
            console.error('❌ Failed to read schema.ts for --all flag.')
            if (error instanceof Error) {
                console.error(error.message)
            }
            process.exit(1)
        }
    }

    if (args.length === 0) {
        usageAndExit(allTables)
    }

    const truncateAll = args.includes('--all')

    let tableName: string | undefined
    let providedFilePath: string | undefined

    if (!truncateAll) {
        const tableNameIndex = args.findIndex((arg) => !arg.startsWith('-'))
        if (tableNameIndex === -1) {
            usageAndExit(allTables)
        }
        tableName = args[tableNameIndex]

        for (let i = 0; i < args.length; i += 1) {
            if (args[i] === '--file') {
                const next = args[i + 1]
                if (!next) {
                    console.error('Error: --file option requires a path.')
                    usageAndExit(allTables)
                }
                providedFilePath = next
                break
            }
        }

        if (!tableName) {
            usageAndExit(allTables)
        }
    }

    const emptyFilePath = providedFilePath ?? join(tmpdir(), `convex-empty-${randomUUID()}.jsonl`)
    const shouldRemoveFile = !providedFilePath

    try {
        if (!providedFilePath) {
            // Ensure Convex receives an empty dataset.
            await writeFile(emptyFilePath, '')
        }

        if (truncateAll) {
            console.log(`🔄 Truncating all Convex tables concurrently (${allTables!.length} tables)...`)
            await Promise.all(allTables!.map(table => truncateTable(table, emptyFilePath)))
            console.log(`✅ All tables successfully cleared.`)
        } else {
            await truncateTable(tableName!, emptyFilePath)
        }
    } catch (error) {
        console.error('❌ Failed to truncate table.')
        if (error instanceof Error) {
            console.error(error.message)
        } else {
            console.error(error)
        }
        process.exitCode = 1
    } finally {
        if (shouldRemoveFile) {
            try {
                await unlink(emptyFilePath)
            } catch {
                // best effort cleanup
            }
        }
    }
}

main()
