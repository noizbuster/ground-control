declare module "node:sqlite" {
	export interface DatabaseSyncOptions {
		readonly?: boolean;
		mode?: number;
	}

	export interface DatabaseSyncStatement<T = unknown> {
		all(...params: unknown[]): T[];
		get(...params: unknown[]): T | undefined;
	}

	export class DatabaseSync {
		constructor(filename: string, options?: DatabaseSyncOptions);
		prepare<T = unknown>(sql: string): DatabaseSyncStatement<T>;
		close(): void;
	}
}
