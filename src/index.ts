import { Decoder, literal, type, union } from 'io-ts';
import { FSEntity, write } from './utils/fs';
import * as path from 'path';
import * as $RefParser from 'json-schema-ref-parser';
import { pipe } from 'fp-ts/lib/pipeable';
import { array, either, taskEither, option } from 'fp-ts';
import { Either, isLeft, toError } from 'fp-ts/lib/Either';
import { identity } from 'fp-ts/lib/function';
import { reportIfFailed } from './utils/io-ts';
import { TaskEither } from 'fp-ts/lib/TaskEither';
import { sketchParser121 } from './parsers/sketch-121';
import { DeepLookup, ResolveRef, ResolveRefContext } from './utils/ref';
import { Reader } from 'fp-ts/lib/Reader';

export interface Language<A> {
	(documents: Record<string, A>): Either<unknown, FSEntity>;
}

export interface GenerateOptions<A> {
	readonly cwd?: string;
	readonly out: string;
	readonly spec: string;
	readonly decoder: Decoder<unknown, A>;
	readonly language: Reader<ResolveRefContext, Language<A>>;
}

const log = (...args: unknown[]) => console.log('[SWAGGER-CODEGEN-TS]:', ...args);
const getUnsafe: <E, A>(e: Either<E, A>) => A = either.fold(e => {
	throw e;
}, identity);

export const generate = <A>(options: GenerateOptions<A>): TaskEither<unknown, void> =>
	taskEither.tryCatch(async () => {
		const cwd = options.cwd || process.cwd();
		const out = path.isAbsolute(options.out) ? options.out : path.resolve(cwd, options.out);
		const spec = path.isAbsolute(options.spec) ? options.spec : path.resolve(cwd, options.spec);
		log('Processing', spec);

		const $refs = await $RefParser.resolve(spec, {
			dereference: {
				circular: 'ignore',
			},
			parse: {
				sketch: sketchParser121,
			},
		});

		const specs: Record<string, A> = pipe(
			Object.entries($refs.values()),
			array.reduce({}, (acc, [fullPath, schema]) => {
				const isRoot = fullPath === spec;
				const relative = path.relative(cwd, fullPath);
				// skip specLike check for root because it should always be decoded with passed decoder and fail
				if (!isRoot && isLeft(specLikeCodec.decode(schema))) {
					log('Unable to decode', relative, 'as spec. Treat it as an arbitrary json.');
					// this is not a spec - treat as arbitrary json
					return acc;
				}
				// use getUnsafe to fail fast if unable to decode a spec
				const decoded = getUnsafe(reportIfFailed(options.decoder.decode(schema)));
				log('Decoded', relative);
				return {
					...acc,
					[relative]: decoded,
				};
			}),
		);

		log('Writing to', out);

		const resolveRef: ResolveRef = ($ref, decoder) =>
			pipe(
				either.tryCatch(() => $refs.get($ref), toError),
				either.chain(resolved => reportIfFailed(decoder.decode(resolved))),
			);

		const deepLookup: DeepLookup = (node: unknown, codec, refCodec) =>
			codec.is(node)
				? option.some(node)
				: refCodec.is(node)
				? pipe(
						option.fromEither(resolveRef(node.$ref, codec)),
						option.alt(() =>
							pipe(
								option.fromEither(resolveRef(node.$ref, refCodec)),
								option.chain(node => deepLookup(node, codec, refCodec)),
							),
						),
				  )
				: option.none;
		await write(out, getUnsafe(options.language({ resolveRef, deepLookup })(specs)));

		log('Done');
	}, identity);

const specLikeCodec = union([
	type({
		swagger: literal('2.0'),
	}),
	type({
		openapi: union([literal('3.0.0'), literal('3.0.1'), literal('3.0.2')]),
	}),
	type({
		asyncapi: literal('2.0.0'),
	}),
	type({
		// sketch-like structure
		meta: type({
			version: literal(121),
		}),
	}),
]);
