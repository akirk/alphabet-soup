/**
 * Alphabet Soup — standalone WpApp port.
 *
 * A framework-agnostic reimplementation of OpenStation's Alphabet
 * Soup game (openstation/src/games/alphabet-soup/). The gameplay,
 * scoring, and daily-seed rules are ported verbatim; anything that
 * depended on the OpenStation desktop shell (PixiJS via
 * `wp.os.loadModules`, native-window management, `wp.os.confirm`)
 * is replaced with a plain-browser equivalent:
 *
 *   - the Pixi scene graph (board.ts + fx.ts)  -> a single <canvas>
 *     2D render loop (see `createSoupStage` below)
 *   - `wp.os` window lifecycle / wallpaper     -> this page IS the
 *     window; `window.blur` pauses, there is no wallpaper to suspend
 *   - `ctx.submitScore` posting to the games
 *     REST API                                 -> POST to this
 *     plugin's own `alphabet-soup/v1/scores` route
 *   - the replay confirm dialog                -> `window.confirm()`
 *
 * Everything else — the seeded RNG, the word-search grid generator,
 * the scoring/streak model, the synthesized sound effects, and the
 * shareable score card — is the same logic as the OpenStation
 * source, so a puzzle played here on a given day matches the one
 * OpenStation serves that day (same date seed, same dictionary
 * ordering) even though the two run on different platforms.
 */
( function () {
	'use strict';

	var config = window.AlphabetSoupConfig || {};

	/* ------------------------------------------------------------ *
	 * Seeded PRNG — FNV-1a hash + mulberry32.
	 * ------------------------------------------------------------ */

	function hash32( input ) {
		var h = 0x811c9dc5;
		for ( var i = 0; i < input.length; i++ ) {
			h ^= input.charCodeAt( i );
			h = Math.imul( h, 0x01000193 );
		}
		return h >>> 0;
	}

	function mulberry32( seed ) {
		var a = seed >>> 0;
		return function next() {
			a = ( a + 0x6d2b79f5 ) | 0;
			var t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
			t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
			return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
		};
	}

	/* ------------------------------------------------------------ *
	 * Daily seed.
	 * ------------------------------------------------------------ */

	function formatDailySeed( date ) {
		var day = String( date.getUTCDate() ).padStart( 2, '0' );
		var month = String( date.getUTCMonth() + 1 ).padStart( 2, '0' );
		var year = String( date.getUTCFullYear() );
		return day + '-' + month + '-' + year;
	}

	function runSeedString( dateSeed, mode, size ) {
		return 'time-attack' === mode
			? dateSeed + '#time-attack#' + size
			: dateSeed + '#' + size;
	}

	function waveRng( seedString, wave ) {
		return mulberry32( hash32( seedString + '#wave-' + wave ) );
	}

	/* ------------------------------------------------------------ *
	 * Modes, sizes, wave shaping.
	 * ------------------------------------------------------------ */

	var SOUP_MODES = [ 'daily', 'time-attack' ];
	var SOUP_SIZES = [ 'small', 'medium', 'big' ];
	var DAILY_WAVE_COUNT = 3;
	var TIME_ATTACK_START_SECONDS = 90;
	var TIME_ATTACK_WORD_BONUS_SECONDS = 4;
	var TIME_ATTACK_WAVE_BONUS_SECONDS = 15;
	var LOW_TIME_SECONDS = 10;

	function sizeCells( size ) {
		if ( 'big' === size ) {
			return 16;
		}
		if ( 'medium' === size ) {
			return 12;
		}
		return 8;
	}

	function baseWordCount( size ) {
		if ( 'big' === size ) {
			return 14;
		}
		if ( 'medium' === size ) {
			return 10;
		}
		return 6;
	}

	function waveConfig( mode, size, wave ) {
		var step = Math.max( 0, wave - 1 );
		var gridSize = sizeCells( size );
		var base = baseWordCount( size );
		if ( 'time-attack' === mode ) {
			return {
				gridSize: gridSize,
				wordCount: Math.min( base + 4, base + step ),
				minLen: 4,
				maxLen: Math.min( gridSize, 9, 6 + step ),
			};
		}
		return {
			gridSize: gridSize,
			wordCount: base + step,
			minLen: 4,
			maxLen: Math.min( gridSize, 10, 6 + step ),
		};
	}

	function isFinalDailyWave( wave ) {
		return wave >= DAILY_WAVE_COUNT;
	}

	/* ------------------------------------------------------------ *
	 * Scoring.
	 * ------------------------------------------------------------ */

	function createSoupScore() {
		return {
			score: 0,
			wordsFound: 0,
			streak: 0,
			bestStreak: 0,
			correctSelections: 0,
			totalSelections: 0,
		};
	}

	function streakMultiplier( streak ) {
		return 1 + 0.15 * Math.min( Math.max( 0, streak ), 10 );
	}

	function wordPoints( length, streak ) {
		return Math.round( 15 * length * streakMultiplier( streak ) );
	}

	function recordFind( state, length ) {
		var points = wordPoints( length, state.streak );
		state.score += points;
		state.wordsFound++;
		state.correctSelections++;
		state.totalSelections++;
		state.streak++;
		state.bestStreak = Math.max( state.bestStreak, state.streak );
		return points;
	}

	function recordMissSelection( state ) {
		state.totalSelections++;
		state.streak = 0;
	}

	function waveClearBonus( wave ) {
		return 150 + 50 * Math.max( 0, wave - 1 );
	}

	function recordWaveClear( state, wave ) {
		var bonus = waveClearBonus( wave );
		state.score += bonus;
		return bonus;
	}

	function accuracyPercent( state ) {
		if ( 0 === state.totalSelections ) {
			return 100;
		}
		return Math.round(
			( state.correctSelections / state.totalSelections ) * 100
		);
	}

	function wordsPerMinute( state, elapsedSeconds ) {
		if ( elapsedSeconds <= 0 ) {
			return 0;
		}
		return Math.round( state.wordsFound * ( 60 / elapsedSeconds ) );
	}

	function buildSoupScoreRow( state, opts ) {
		var elapsed = Math.max( 0, Math.round( opts.elapsedSeconds ) );
		return {
			score: state.score,
			meta: {
				mode: opts.mode,
				size: opts.size,
				words: state.wordsFound,
				wpm: wordsPerMinute( state, Math.max( 1, elapsed ) ),
				accuracy: accuracyPercent( state ),
				streak: state.bestStreak,
				wave: opts.wave,
				time: elapsed,
			},
		};
	}

	/* ------------------------------------------------------------ *
	 * Dictionary.
	 * ------------------------------------------------------------ */

	function parseDictionary( raw ) {
		var words = [];
		raw.split( '\n' ).forEach( function ( line ) {
			var word = line.trim();
			if ( '' === word || '#' === word.charAt( 0 ) ) {
				return;
			}
			words.push( word );
		} );

		var bucketStart = {};
		var bucketEnd = {};
		for ( var i = 0; i < words.length; i++ ) {
			var len = words[ i ].length;
			if ( undefined === bucketStart[ len ] ) {
				bucketStart[ len ] = i;
			}
			bucketEnd[ len ] = i + 1;
		}

		function sliceFor( minLen, maxLen ) {
			var start = -1;
			var end = -1;
			for ( var len = minLen; len <= maxLen; len++ ) {
				if ( undefined === bucketStart[ len ] ) {
					continue;
				}
				if ( -1 === start ) {
					start = bucketStart[ len ];
				}
				end = bucketEnd[ len ];
			}
			if ( -1 === start ) {
				return { start: 0, end: words.length };
			}
			return { start: start, end: end };
		}

		function drawOne( minLen, maxLen, rng ) {
			var slice = sliceFor( minLen, maxLen );
			var span = slice.end - slice.start;
			if ( span <= 0 ) {
				return '';
			}
			var offset = Math.floor( span * Math.pow( rng(), 1.4 ) );
			return words[ slice.start + Math.min( offset, span - 1 ) ];
		}

		return {
			size: words.length,
			pick: function ( minLen, maxLen, rng, avoidInitials ) {
				var word = drawOne( minLen, maxLen, rng );
				if ( avoidInitials && avoidInitials.size > 0 ) {
					var attempt = 0;
					while (
						attempt < 3 &&
						'' !== word &&
						avoidInitials.has( word.charAt( 0 ) )
					) {
						word = drawOne( minLen, maxLen, rng );
						attempt++;
					}
				}
				return word;
			},
		};
	}

	function loadDictionary( url ) {
		return fetch( url, { credentials: 'same-origin' } ).then( function (
			res
		) {
			if ( ! res.ok ) {
				throw new Error(
					'Alphabet Soup dictionary failed to load (' +
						res.status +
						').'
				);
			}
			return res.text();
		} ).then( function ( raw ) {
			var dictionary = parseDictionary( raw );
			if ( 0 === dictionary.size ) {
				throw new Error( 'Alphabet Soup dictionary is empty.' );
			}
			return dictionary;
		} );
	}

	/* ------------------------------------------------------------ *
	 * Grid generation + selection geometry.
	 * ------------------------------------------------------------ */

	var DIRECTIONS = [
		[ 0, 1 ], [ 1, 0 ], [ 1, 1 ], [ 1, -1 ],
		[ 0, -1 ], [ -1, 0 ], [ -1, -1 ], [ -1, 1 ],
	];
	var WORD_DRAW_ATTEMPTS = 24;
	var PLACEMENT_ATTEMPTS = 120;
	var DECOY_BAG_BIAS = 0.6;
	var ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

	function tryPlaceWord( letters, size, word, rng ) {
		for ( var attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++ ) {
			var dir = DIRECTIONS[ Math.floor( rng() * DIRECTIONS.length ) ];
			var span = word.length - 1;
			var rowMin = dir[ 0 ] < 0 ? span : 0;
			var rowMax = dir[ 0 ] > 0 ? size - 1 - span : size - 1;
			var colMin = dir[ 1 ] < 0 ? span : 0;
			var colMax = dir[ 1 ] > 0 ? size - 1 - span : size - 1;
			if ( rowMax < rowMin || colMax < colMin ) {
				continue;
			}
			var row = rowMin + Math.floor( rng() * ( rowMax - rowMin + 1 ) );
			var col = colMin + Math.floor( rng() * ( colMax - colMin + 1 ) );

			var cells = [];
			var fits = true;
			for ( var i = 0; i < word.length; i++ ) {
				var r = row + dir[ 0 ] * i;
				var c = col + dir[ 1 ] * i;
				if ( null !== letters[ r ][ c ] ) {
					fits = false;
					break;
				}
				cells.push( { row: r, col: c } );
			}
			if ( ! fits ) {
				continue;
			}
			for ( var j = 0; j < word.length; j++ ) {
				letters[ cells[ j ].row ][ cells[ j ].col ] = word[ j ];
			}
			return cells;
		}
		return null;
	}

	function generateSoup( opts ) {
		var size = opts.size;
		var dictionary = opts.dictionary;
		var rng = opts.rng;
		var maxLen = Math.min( opts.maxLen, size );
		var minLen = Math.min( opts.minLen, maxLen );

		var letters = [];
		for ( var row = 0; row < size; row++ ) {
			letters.push( new Array( size ).fill( null ) );
		}

		var chosen = [];
		var seen = {};
		for ( var i = 0; i < opts.wordCount; i++ ) {
			for ( var attempt = 0; attempt < WORD_DRAW_ATTEMPTS; attempt++ ) {
				var word = dictionary.pick( minLen, maxLen, rng );
				if ( '' === word || word.length > size || seen[ word ] ) {
					continue;
				}
				seen[ word ] = true;
				chosen.push( word );
				break;
			}
		}
		chosen.sort( function ( a, b ) {
			return b.length - a.length || ( a < b ? -1 : 1 );
		} );

		var placed = [];
		chosen.forEach( function ( word ) {
			var cells = tryPlaceWord( letters, size, word, rng );
			if ( cells ) {
				placed.push( { word: word, cells: cells } );
			}
		} );

		var bag = [];
		placed.forEach( function ( entry ) {
			for ( var k = 0; k < entry.word.length; k++ ) {
				bag.push( entry.word[ k ] );
			}
		} );
		var filled = letters.map( function ( rowLetters ) {
			return rowLetters.map( function ( letter ) {
				if ( null !== letter ) {
					return letter;
				}
				if ( bag.length > 0 && rng() < DECOY_BAG_BIAS ) {
					return bag[ Math.floor( rng() * bag.length ) ];
				}
				return ALPHABET[ Math.floor( rng() * ALPHABET.length ) ];
			} );
		} );

		return { size: size, letters: filled, words: placed };
	}

	function lineCells( anchor, target, size ) {
		var dRow = target.row - anchor.row;
		var dCol = target.col - anchor.col;
		if ( 0 === dRow && 0 === dCol ) {
			return [ anchor ];
		}
		var angle = Math.atan2( dRow, dCol );
		var spoke = Math.round( angle / ( Math.PI / 4 ) );
		var stepRow = [ 0, 1, 1, 1, 0, -1, -1, -1 ][ ( spoke + 8 ) % 8 ];
		var stepCol = [ 1, 1, 0, -1, -1, -1, 0, 1 ][ ( spoke + 8 ) % 8 ];
		var along =
			0 !== stepRow && 0 !== stepCol
				? Math.min( Math.abs( dRow ), Math.abs( dCol ) )
				: Math.abs( 0 !== stepRow ? dRow : dCol );

		var cells = [];
		for ( var i = 0; i <= along; i++ ) {
			var row = anchor.row + stepRow * i;
			var col = anchor.col + stepCol * i;
			if ( row < 0 || row >= size || col < 0 || col >= size ) {
				break;
			}
			cells.push( { row: row, col: col } );
		}
		return cells;
	}

	function pathKey( cells ) {
		return cells
			.map( function ( cell ) {
				return cell.row + ':' + cell.col;
			} )
			.join( '|' );
	}

	function selectionMatches( grid, selection ) {
		if ( selection.length < 2 ) {
			return -1;
		}
		var forward = pathKey( selection );
		var backward = pathKey( selection.slice().reverse() );
		for ( var i = 0; i < grid.words.length; i++ ) {
			var key = pathKey( grid.words[ i ].cells );
			if ( key === forward || key === backward ) {
				return i;
			}
		}
		return -1;
	}

	/* ------------------------------------------------------------ *
	 * Synthesized sound effects (Web Audio, no assets).
	 * ------------------------------------------------------------ */

	var SOUND_STORAGE_KEY = 'alphabet-soup/sound';
	var MASTER_LEVEL = 0.16;
	var PLUCK_LEVEL = 0.5;
	var PENTATONIC = [ 0, 2, 4, 7, 9 ];
	var BASE_FREQUENCY = 220;

	function selectionStepFrequency( index ) {
		var step = Math.max( 0, Math.floor( index ) );
		var semitones =
			12 * Math.floor( step / PENTATONIC.length ) +
			PENTATONIC[ step % PENTATONIC.length ];
		return BASE_FREQUENCY * Math.pow( 2, semitones / 12 );
	}

	function readStoredSoundEnabled() {
		try {
			return window.localStorage.getItem( SOUND_STORAGE_KEY ) !== '0';
		} catch ( e ) {
			return true;
		}
	}

	function storeSoundEnabled( enabled ) {
		try {
			window.localStorage.setItem(
				SOUND_STORAGE_KEY,
				enabled ? '1' : '0'
			);
		} catch ( e ) {
			/* best effort */
		}
	}

	function createSoupAudio() {
		var ctx = null;
		var master = null;
		var enabled = readStoredSoundEnabled();
		var disposed = false;

		function ensureContext() {
			if ( disposed ) {
				return null;
			}
			if ( ctx ) {
				if ( 'suspended' === ctx.state ) {
					ctx.resume().catch( function () {} );
				}
				return ctx;
			}
			var Ctor = window.AudioContext || window.webkitAudioContext;
			if ( ! Ctor ) {
				return null;
			}
			try {
				ctx = new Ctor();
			} catch ( e ) {
				return null;
			}
			master = ctx.createGain();
			master.gain.value = MASTER_LEVEL;
			master.connect( ctx.destination );
			return ctx;
		}

		function pluck( frequency, opts ) {
			opts = opts || {};
			if ( ! enabled || frequency <= 0 ) {
				return;
			}
			var context = ensureContext();
			if ( ! context || ! master ) {
				return;
			}
			var type = opts.type || 'sine';
			var delay = opts.delay || 0;
			var duration = opts.duration || 0.22;
			var level = undefined === opts.level ? PLUCK_LEVEL : opts.level;
			var start = context.currentTime + delay;
			var osc = context.createOscillator();
			var gain = context.createGain();
			osc.type = type;
			osc.frequency.value = frequency;
			gain.gain.setValueAtTime( 0.0001, start );
			gain.gain.exponentialRampToValueAtTime( level, start + 0.008 );
			gain.gain.exponentialRampToValueAtTime(
				0.0001,
				start + duration
			);
			osc.connect( gain );
			gain.connect( master );
			osc.start( start );
			osc.stop( start + duration + 0.05 );
		}

		return {
			cellTouch: function ( index ) {
				pluck( selectionStepFrequency( index ), {
					duration: 0.14,
					level: 0.35,
				} );
			},
			found: function ( length ) {
				var root = selectionStepFrequency( Math.min( length, 6 ) );
				pluck( root, { duration: 0.3 } );
				pluck( root * 1.25, { delay: 0.05, duration: 0.3 } );
				pluck( root * 1.5, { delay: 0.1, duration: 0.35 } );
				pluck( root * 2, { delay: 0.16, duration: 0.4, level: 0.4 } );
			},
			invalid: function () {
				pluck( 110, { type: 'triangle', duration: 0.15, level: 0.35 } );
				pluck( 116, { type: 'triangle', duration: 0.12, level: 0.2 } );
			},
			waveClear: function () {
				pluck( 330, { duration: 0.25 } );
				pluck( 415, { delay: 0.09, duration: 0.25 } );
				pluck( 494, { delay: 0.18, duration: 0.3 } );
				pluck( 660, { delay: 0.28, duration: 0.5, level: 0.45 } );
			},
			tick: function () {
				pluck( 880, { type: 'triangle', duration: 0.06, level: 0.18 } );
			},
			gameOver: function () {
				pluck( 392, { type: 'triangle', duration: 0.35, level: 0.4 } );
				pluck( 311, {
					type: 'triangle',
					delay: 0.14,
					duration: 0.45,
					level: 0.4,
				} );
			},
			setEnabled: function ( next ) {
				enabled = next;
				storeSoundEnabled( next );
			},
			isEnabled: function () {
				return enabled;
			},
			dispose: function () {
				disposed = true;
				if ( ctx ) {
					ctx.close().catch( function () {} );
					ctx = null;
					master = null;
				}
			},
		};
	}

	/* ------------------------------------------------------------ *
	 * Canvas 2D board + fx — replaces OpenStation's PixiJS scene.
	 *
	 * One render loop draws the backdrop, the letter tiles (with the
	 * same entrance/pop timings as the original), the selection and
	 * locked-word capsules, and the decorative particles (bursts,
	 * floating score text, wave banners, confetti). Geometry (which
	 * cells a drag covers) stays in the pure `lineCells`/
	 * `selectionMatches` functions above; this module only draws.
	 * ------------------------------------------------------------ */

	var TILE_FONT = '"Trebuchet MS", "Segoe UI", Verdana, sans-serif';
	var BACKDROP_COLOR = '#1c1233';
	var CELL_COLOR = 'rgba(255,255,255,0.05)';
	var LETTER_COLOR = '#f3efff';
	var LOCKED_LETTER_COLOR = '#241736';
	var SELECTION_COLOR = '#ffd166';
	var WORD_COLORS = [
		'#ff6b6b', '#ffd166', '#06d6a0', '#4cc9f0', '#c77dff',
		'#f4978e', '#90e0ef', '#ffe066', '#80ed99', '#f9c74f',
	];

	var ENTRANCE_SECONDS = 0.3;
	var ENTRANCE_STAGGER = 0.035;
	var POP_SECONDS = 0.35;
	var FLASH_SECONDS = 0.45;
	var GRAVITY = 560;
	var BURST_LIFETIME = 0.7;
	var SCORE_LIFETIME = 0.9;
	var BANNER_LIFETIME = 1.4;
	var CONFETTI_LIFETIME = 1.6;

	function createSoupStage( canvas ) {
		var ctx2d = canvas.getContext( '2d' );
		var dpr = Math.min( window.devicePixelRatio || 1, 2 );
		var width = 0;
		var height = 0;
		var grid = null;
		var tiles = [];
		var locked = [];
		var flashes = [];
		var selection = [];
		var particles = [];
		var cell = 48;
		var originX = 0;
		var originY = 0;
		var lockedCells = {};

		function cellKey( c ) {
			return c.row + ':' + c.col;
		}

		function computeLayout() {
			if ( ! grid ) {
				return;
			}
			var pad = 18;
			cell = Math.max(
				24,
				Math.min(
					( width - pad * 2 ) / grid.size,
					( height - pad * 2 ) / grid.size,
					64
				)
			);
			originX = ( width - cell * grid.size ) / 2;
			originY = ( height - cell * grid.size ) / 2;
		}

		function center( c ) {
			return {
				x: originX + ( c.col + 0.5 ) * cell,
				y: originY + ( c.row + 0.5 ) * cell,
			};
		}

		function rebuildTiles() {
			tiles = [];
			if ( ! grid ) {
				return;
			}
			for ( var row = 0; row < grid.size; row++ ) {
				for ( var col = 0; col < grid.size; col++ ) {
					tiles.push( {
						row: row,
						col: col,
						letter: grid.letters[ row ][ col ].toUpperCase(),
						delay: ( row + col ) * ENTRANCE_STAGGER,
						age: 0,
						popAge: -1,
						popDelay: 0,
					} );
				}
			}
		}

		function drawCapsule( cells, color, alpha, thicknessScale ) {
			if ( 0 === cells.length ) {
				return;
			}
			var thickness = cell * ( thicknessScale || 0.78 );
			ctx2d.save();
			ctx2d.globalAlpha = alpha;
			ctx2d.strokeStyle = color;
			ctx2d.fillStyle = color;
			ctx2d.lineCap = 'round';
			var from = center( cells[ 0 ] );
			if ( 1 === cells.length ) {
				ctx2d.beginPath();
				ctx2d.arc( from.x, from.y, thickness / 2, 0, Math.PI * 2 );
				ctx2d.fill();
			} else {
				var to = center( cells[ cells.length - 1 ] );
				ctx2d.lineWidth = thickness;
				ctx2d.beginPath();
				ctx2d.moveTo( from.x, from.y );
				ctx2d.lineTo( to.x, to.y );
				ctx2d.stroke();
			}
			ctx2d.restore();
		}

		function roundRect( x, y, w, h, r ) {
			ctx2d.beginPath();
			ctx2d.moveTo( x + r, y );
			ctx2d.arcTo( x + w, y, x + w, y + h, r );
			ctx2d.arcTo( x + w, y + h, x, y + h, r );
			ctx2d.arcTo( x, y + h, x, y, r );
			ctx2d.arcTo( x, y, x + w, y, r );
			ctx2d.closePath();
		}

		function paintBackdrop() {
			ctx2d.fillStyle = BACKDROP_COLOR;
			ctx2d.fillRect( 0, 0, width, height );
			var glowA = ctx2d.createRadialGradient(
				width * 0.22, height * 0.2, 0,
				width * 0.22, height * 0.2, Math.max( width, height ) * 0.4
			);
			glowA.addColorStop( 0, 'rgba(59,42,104,0.35)' );
			glowA.addColorStop( 1, 'rgba(59,42,104,0)' );
			ctx2d.fillStyle = glowA;
			ctx2d.fillRect( 0, 0, width, height );
			var glowB = ctx2d.createRadialGradient(
				width * 0.85, height * 0.9, 0,
				width * 0.85, height * 0.9, Math.max( width, height ) * 0.45
			);
			glowB.addColorStop( 0, 'rgba(35,42,92,0.4)' );
			glowB.addColorStop( 1, 'rgba(35,42,92,0)' );
			ctx2d.fillStyle = glowB;
			ctx2d.fillRect( 0, 0, width, height );

			if ( ! grid ) {
				return;
			}
			var platePad = Math.min( 14, cell * 0.3 );
			ctx2d.fillStyle = 'rgba(0,0,0,0.28)';
			roundRect(
				originX - platePad,
				originY - platePad,
				cell * grid.size + platePad * 2,
				cell * grid.size + platePad * 2,
				Math.min( 22, cell * 0.5 )
			);
			ctx2d.fill();
			ctx2d.fillStyle = CELL_COLOR;
			for ( var row = 0; row < grid.size; row++ ) {
				for ( var col = 0; col < grid.size; col++ ) {
					var p = center( { row: row, col: col } );
					roundRect(
						p.x - cell * 0.42,
						p.y - cell * 0.42,
						cell * 0.84,
						cell * 0.84,
						cell * 0.2
					);
					ctx2d.fill();
				}
			}
		}

		function drawTiles( dt ) {
			tiles.forEach( function ( tile ) {
				tile.age += dt;
				var t = Math.min(
					1,
					Math.max( 0, ( tile.age - tile.delay ) / ENTRANCE_SECONDS )
				);
				var eased =
					1 + 2.7 * Math.pow( t - 1, 3 ) + 1.7 * Math.pow( t - 1, 2 );
				var scale = eased;
				var alpha = Math.min( 1, t * 1.6 );
				if ( tile.popAge >= 0 ) {
					tile.popAge += dt;
					var pt = Math.min(
						1,
						Math.max( 0, ( tile.popAge - tile.popDelay ) / POP_SECONDS )
					);
					scale *= 1 + 0.35 * Math.sin( Math.PI * pt );
					if ( pt >= 1 ) {
						tile.popAge = -1;
					}
				}
				scale = Math.max( 0, scale );
				if ( alpha <= 0 || scale <= 0 ) {
					return;
				}
				var p = center( { row: tile.row, col: tile.col } );
				ctx2d.save();
				ctx2d.globalAlpha = alpha;
				ctx2d.translate( p.x, p.y );
				ctx2d.scale( scale, scale );
				ctx2d.fillStyle = lockedCells[ cellKey( {
					row: tile.row,
					col: tile.col,
				} ) ]
					? LOCKED_LETTER_COLOR
					: LETTER_COLOR;
				ctx2d.font =
					'700 ' + Math.round( cell * 0.52 ) + 'px ' + TILE_FONT;
				ctx2d.textAlign = 'center';
				ctx2d.textBaseline = 'middle';
				ctx2d.fillText( tile.letter, 0, 1 );
				ctx2d.restore();
			} );
		}

		function drawFlashes( dt ) {
			flashes = flashes.filter( function ( flash ) {
				flash.age += dt;
				return flash.age < FLASH_SECONDS;
			} );
			flashes.forEach( function ( flash ) {
				var progress = Math.min( 1, flash.age / FLASH_SECONDS );
				drawCapsule( flash.cells, '#ff5470', 0.5 * ( 1 - progress ) );
			} );
		}

		function drawParticles( dt ) {
			particles = particles.filter( function ( fx ) {
				fx.age += dt;
				if ( 'burst' === fx.kind ) {
					fx.parts.forEach( function ( part ) {
						part.vy += GRAVITY * dt;
						part.x += part.vx * dt;
						part.y += part.vy * dt;
					} );
					return fx.age < BURST_LIFETIME;
				}
				if ( 'score' === fx.kind ) {
					fx.y -= 46 * dt;
					return fx.age < SCORE_LIFETIME;
				}
				if ( 'banner' === fx.kind ) {
					return fx.age < BANNER_LIFETIME;
				}
				// confetti
				fx.parts.forEach( function ( part ) {
					part.x += part.vx * dt;
					part.y += part.vy * dt;
					part.rotation += part.spin * dt;
				} );
				return fx.age < CONFETTI_LIFETIME;
			} );

			particles.forEach( function ( fx ) {
				if ( 'burst' === fx.kind ) {
					var alpha = Math.max( 0, 1 - fx.age / BURST_LIFETIME );
					fx.parts.forEach( function ( part ) {
						ctx2d.save();
						ctx2d.globalAlpha = alpha * 0.95;
						ctx2d.fillStyle = fx.color;
						ctx2d.beginPath();
						ctx2d.arc( part.x, part.y, part.r, 0, Math.PI * 2 );
						ctx2d.fill();
						ctx2d.restore();
					} );
					return;
				}
				if ( 'score' === fx.kind ) {
					var progress = fx.age / SCORE_LIFETIME;
					ctx2d.save();
					ctx2d.globalAlpha = Math.max( 0, 1 - progress * progress );
					ctx2d.fillStyle = fx.color;
					ctx2d.font = '700 22px ' + TILE_FONT;
					ctx2d.textAlign = 'center';
					ctx2d.textBaseline = 'middle';
					ctx2d.fillText( fx.text, fx.x, fx.y );
					ctx2d.restore();
					return;
				}
				if ( 'banner' === fx.kind ) {
					var bp = Math.min( 1, fx.age / BANNER_LIFETIME );
					var inT = Math.min( 1, bp / 0.18 );
					var eased = 1 - ( 1 - inT ) * ( 1 - inT );
					var bScale = 0.6 + 0.4 * eased;
					var bAlpha =
						bp < 0.75 ? eased : Math.max( 0, 1 - ( bp - 0.75 ) / 0.25 );
					ctx2d.save();
					ctx2d.globalAlpha = bAlpha;
					ctx2d.translate( fx.x, fx.y );
					ctx2d.scale( bScale, bScale );
					ctx2d.fillStyle = '#ffffff';
					ctx2d.font = '700 40px ' + TILE_FONT;
					ctx2d.textAlign = 'center';
					ctx2d.textBaseline = 'middle';
					ctx2d.fillText( fx.text, 0, 0 );
					ctx2d.restore();
					return;
				}
				// confetti
				var cAlpha = Math.max( 0, 1 - fx.age / CONFETTI_LIFETIME );
				fx.parts.forEach( function ( part ) {
					ctx2d.save();
					ctx2d.globalAlpha = cAlpha * 0.95;
					ctx2d.translate( part.x, part.y );
					ctx2d.rotate( part.rotation );
					ctx2d.fillStyle = part.color;
					roundRect( -3, -5, 6, 10, 2 );
					ctx2d.fill();
					ctx2d.restore();
				} );
			} );
		}

		function render( dt ) {
			canvas.width = Math.max( 1, Math.round( width * dpr ) );
			canvas.height = Math.max( 1, Math.round( height * dpr ) );
			canvas.style.width = width + 'px';
			canvas.style.height = height + 'px';
			ctx2d.setTransform( dpr, 0, 0, dpr, 0, 0 );

			paintBackdrop();
			drawTiles( dt );
			locked.forEach( function ( entry ) {
				drawCapsule( entry.cells, entry.color, 0.85 );
			} );
			if ( selection.length > 0 ) {
				drawCapsule( selection, SELECTION_COLOR, 0.35 );
				selection.forEach( function ( c ) {
					var p = center( c );
					ctx2d.save();
					ctx2d.globalAlpha = 0.7;
					ctx2d.fillStyle = SELECTION_COLOR;
					ctx2d.beginPath();
					ctx2d.arc( p.x, p.y, cell * 0.12, 0, Math.PI * 2 );
					ctx2d.fill();
					ctx2d.restore();
				} );
			}
			drawFlashes( dt );
			drawParticles( dt );
		}

		return {
			setGrid: function ( next ) {
				grid = next;
				locked = [];
				flashes = [];
				selection = [];
				lockedCells = {};
				computeLayout();
				rebuildTiles();
			},
			relayout: function ( w, h ) {
				width = w;
				height = h;
				computeLayout();
			},
			cellAt: function ( x, y ) {
				if ( ! grid ) {
					return null;
				}
				var col = Math.floor( ( x - originX ) / cell );
				var row = Math.floor( ( y - originY ) / cell );
				if ( row < 0 || row >= grid.size || col < 0 || col >= grid.size ) {
					return null;
				}
				return { row: row, col: col };
			},
			cellCenter: function ( c ) {
				return center( c );
			},
			showSelection: function ( cells ) {
				selection = cells;
			},
			clearSelection: function () {
				selection = [];
			},
			lockWord: function ( cells, color ) {
				locked.push( { cells: cells, color: color } );
				cells.forEach( function ( c, i ) {
					lockedCells[ cellKey( c ) ] = true;
					var tile = tiles.filter( function ( t ) {
						return t.row === c.row && t.col === c.col;
					} )[ 0 ];
					if ( tile ) {
						tile.popAge = 0;
						tile.popDelay = i * 0.03;
					}
				} );
			},
			flashInvalid: function ( cells ) {
				flashes.push( { cells: cells, age: 0 } );
			},
			burstAt: function ( x, y, color ) {
				var parts = [];
				var count = 10;
				for ( var i = 0; i < count; i++ ) {
					var angle = ( i / count ) * Math.PI * 2 + Math.random() * 0.6;
					var speed = 90 + Math.random() * 160;
					parts.push( {
						x: x,
						y: y,
						r: 2 + Math.random() * 2.5,
						vx: Math.cos( angle ) * speed,
						vy: Math.sin( angle ) * speed - 60,
					} );
				}
				particles.push( { kind: 'burst', parts: parts, color: color, age: 0 } );
			},
			floatScore: function ( x, y, text, color ) {
				particles.push( {
					kind: 'score', x: x, y: y, text: text, color: color, age: 0,
				} );
			},
			banner: function ( text, x, y ) {
				particles.push( { kind: 'banner', x: x, y: y, text: text, age: 0 } );
			},
			confetti: function ( widthPx, colors ) {
				var parts = [];
				var count = 36;
				for ( var i = 0; i < count; i++ ) {
					parts.push( {
						x: Math.random() * widthPx,
						y: -14 - Math.random() * 40,
						vx: ( Math.random() - 0.5 ) * 90,
						vy: 120 + Math.random() * 160,
						rotation: Math.random() * Math.PI,
						spin: ( Math.random() - 0.5 ) * 8,
						color: colors[ Math.floor( Math.random() * colors.length ) ],
					} );
				}
				particles.push( { kind: 'confetti', parts: parts, age: 0 } );
			},
			clearFx: function () {
				particles = [];
			},
			render: render,
		};
	}

	/* ------------------------------------------------------------ *
	 * Shareable score card (verbatim port — already framework-free).
	 * ------------------------------------------------------------ */

	var SHARE_CARD_WIDTH = 1200;
	var SHARE_CARD_HEIGHT = 630;
	var DECO_TILES = [
		[ 1020, 96, 74, -0.16 ], [ 1108, 210, 56, 0.22 ], [ 966, 250, 44, 0.42 ],
		[ 1084, 356, 66, -0.28 ], [ 90, 520, 54, 0.18 ], [ 170, 570, 40, -0.32 ],
	];
	var DECO_COLORS = [ '#ff6b6b', '#ffd166', '#06d6a0', '#4cc9f0', '#c77dff', '#90e0ef' ];
	var CARD_FONT = '"Trebuchet MS", "Segoe UI", Verdana, sans-serif';

	function cardRoundRectPath( ctx2d, x, y, w, h, r ) {
		ctx2d.beginPath();
		ctx2d.moveTo( x + r, y );
		ctx2d.arcTo( x + w, y, x + w, y + h, r );
		ctx2d.arcTo( x + w, y + h, x, y + h, r );
		ctx2d.arcTo( x, y + h, x, y, r );
		ctx2d.arcTo( x, y, x + w, y, r );
		ctx2d.closePath();
	}

	function formatScore( score ) {
		return Math.max( 0, Math.round( score ) ).toLocaleString();
	}

	function renderShareCard( canvas, data ) {
		canvas.width = SHARE_CARD_WIDTH;
		canvas.height = SHARE_CARD_HEIGHT;
		var ctx2d = canvas.getContext( '2d' );
		if ( ! ctx2d ) {
			return;
		}
		var accent = data.accent || '#ffd166';
		var w = SHARE_CARD_WIDTH;
		var h = SHARE_CARD_HEIGHT;

		ctx2d.fillStyle = '#1c1233';
		ctx2d.fillRect( 0, 0, w, h );
		var glowA = ctx2d.createRadialGradient( w * 0.2, h * 0.1, 40, w * 0.2, h * 0.1, 620 );
		glowA.addColorStop( 0, 'rgba(105, 78, 189, 0.55)' );
		glowA.addColorStop( 1, 'rgba(105, 78, 189, 0)' );
		ctx2d.fillStyle = glowA;
		ctx2d.fillRect( 0, 0, w, h );
		var glowB = ctx2d.createRadialGradient( w * 0.92, h * 0.95, 40, w * 0.92, h * 0.95, 560 );
		glowB.addColorStop( 0, 'rgba(41, 128, 185, 0.4)' );
		glowB.addColorStop( 1, 'rgba(41, 128, 185, 0)' );
		ctx2d.fillStyle = glowB;
		ctx2d.fillRect( 0, 0, w, h );

		var letters = ( data.gameTitle.replace( /[^a-z]/gi, '' ) || 'ABC' ).toUpperCase();
		DECO_TILES.forEach( function ( tile, i ) {
			var x = tile[ 0 ], y = tile[ 1 ], size = tile[ 2 ], rotation = tile[ 3 ];
			ctx2d.save();
			ctx2d.translate( x, y );
			ctx2d.rotate( rotation );
			ctx2d.globalAlpha = 0.16;
			ctx2d.fillStyle = DECO_COLORS[ i % DECO_COLORS.length ];
			cardRoundRectPath( ctx2d, -size / 2, -size / 2, size, size, size * 0.24 );
			ctx2d.fill();
			ctx2d.globalAlpha = 0.4;
			ctx2d.fillStyle = '#ffffff';
			ctx2d.font = '700 ' + Math.round( size * 0.56 ) + 'px ' + CARD_FONT;
			ctx2d.textAlign = 'center';
			ctx2d.textBaseline = 'middle';
			ctx2d.fillText( letters[ i % letters.length ], 0, size * 0.04 );
			ctx2d.restore();
		} );

		ctx2d.textAlign = 'left';
		ctx2d.textBaseline = 'alphabetic';
		ctx2d.fillStyle = accent;
		ctx2d.beginPath();
		ctx2d.arc( 96, 104, 14, 0, Math.PI * 2 );
		ctx2d.fill();
		ctx2d.fillStyle = '#f3efff';
		ctx2d.font = '700 52px ' + CARD_FONT;
		ctx2d.fillText( data.gameTitle, 130, 122 );

		ctx2d.font = '600 26px ' + CARD_FONT;
		var pillText = data.puzzleLabel;
		var pillWidth = ctx2d.measureText( pillText ).width + 56;
		cardRoundRectPath( ctx2d, 96, 156, pillWidth, 54, 27 );
		ctx2d.fillStyle = 'rgba(255, 255, 255, 0.1)';
		ctx2d.fill();
		ctx2d.fillStyle = 'rgba(243, 239, 255, 0.85)';
		ctx2d.fillText( pillText, 124, 192 );

		var scoreText = formatScore( data.score );
		var scoreGradient = ctx2d.createLinearGradient( 96, 260, 96, 420 );
		scoreGradient.addColorStop( 0, '#ffffff' );
		scoreGradient.addColorStop( 1, accent );
		ctx2d.fillStyle = scoreGradient;
		ctx2d.font = '700 150px ' + CARD_FONT;
		ctx2d.fillText( scoreText, 90, 420 );
		var scoreWidth = ctx2d.measureText( scoreText ).width;
		ctx2d.fillStyle = 'rgba(243, 239, 255, 0.65)';
		ctx2d.font = '600 30px ' + CARD_FONT;
		ctx2d.fillText( data.scoreLabel, 100 + scoreWidth, 418 );

		var stats = data.stats.slice( 0, 5 );
		if ( stats.length > 0 ) {
			var gap = 18;
			var tileW = Math.min( 200, ( w - 192 - gap * ( stats.length - 1 ) ) / stats.length );
			var tileH = 108;
			var top = 462;
			stats.forEach( function ( stat, i ) {
				var x = 96 + i * ( tileW + gap );
				cardRoundRectPath( ctx2d, x, top, tileW, tileH, 18 );
				ctx2d.fillStyle = 'rgba(255, 255, 255, 0.07)';
				ctx2d.fill();
				ctx2d.fillStyle = '#ffffff';
				ctx2d.font = '700 40px ' + CARD_FONT;
				ctx2d.fillText( stat.value, x + 22, top + 56 );
				ctx2d.fillStyle = 'rgba(243, 239, 255, 0.6)';
				ctx2d.font = '600 20px ' + CARD_FONT;
				ctx2d.fillText( stat.label.toUpperCase(), x + 22, top + 90 );
			} );
		}

		ctx2d.textAlign = 'right';
		ctx2d.fillStyle = 'rgba(243, 239, 255, 0.5)';
		ctx2d.font = '600 22px ' + CARD_FONT;
		ctx2d.fillText( data.footer, w - 60, h - 40 );
	}

	function cardBlob( canvas ) {
		return new Promise( function ( resolve ) {
			canvas.toBlob( function ( blob ) {
				resolve( blob );
			}, 'image/png' );
		} );
	}

	function downloadCard( canvas, filename ) {
		var link = document.createElement( 'a' );
		link.href = canvas.toDataURL( 'image/png' );
		link.download = filename;
		link.click();
	}

	function copyCardToClipboard( blob ) {
		var nav = window.navigator;
		if ( ! nav.clipboard || ! nav.clipboard.write || ! window.ClipboardItem ) {
			return Promise.resolve( false );
		}
		return nav.clipboard
			.write( [ new window.ClipboardItem( { 'image/png': blob } ) ] )
			.then( function () {
				return true;
			} )
			.catch( function () {
				return false;
			} );
	}

	function shareScoreCard( canvas, filename, title ) {
		return cardBlob( canvas ).then( function ( blob ) {
			if ( ! blob ) {
				return 'failed';
			}
			var nav = window.navigator;
			var file = new File( [ blob ], filename, { type: 'image/png' } );
			if (
				'function' === typeof nav.share &&
				( 'function' !== typeof nav.canShare || nav.canShare( { files: [ file ] } ) )
			) {
				return nav
					.share( { files: [ file ], title: title } )
					.then( function () {
						return 'shared';
					} )
					.catch( function () {
						return copyCardToClipboard( blob ).then( function ( copied ) {
							if ( copied ) {
								return 'copied';
							}
							downloadCard( canvas, filename );
							return 'downloaded';
						} );
					} );
			}
			return copyCardToClipboard( blob ).then( function ( copied ) {
				if ( copied ) {
					return 'copied';
				}
				downloadCard( canvas, filename );
				return 'downloaded';
			} );
		} );
	}

	/* ------------------------------------------------------------ *
	 * REST client — the leaderboard endpoints this plugin ships
	 * (src/Rest.php), mirroring OpenStation's "arcade trust model":
	 * the client asserts a score, the server clamps/sanitizes it.
	 * ------------------------------------------------------------ */

	function submitScoreToServer( row ) {
		return fetch( config.restUrl + 'alphabet-soup/v1/scores', {
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				'Content-Type': 'application/json',
				'X-WP-Nonce': config.restNonce || '',
			},
			body: JSON.stringify( row ),
		} ).then( function ( res ) {
			if ( ! res.ok ) {
				throw new Error( 'Score request failed (' + res.status + ').' );
			}
			return res.json();
		} );
	}

	/* ------------------------------------------------------------ *
	 * Local ledgers (mode/size picks, played-today, sound pref) —
	 * same localStorage keys style as OpenStation, own namespace.
	 * ------------------------------------------------------------ */

	var MODE_STORAGE_KEY = 'alphabet-soup/mode';
	var SIZE_STORAGE_KEY = 'alphabet-soup/size';
	var PLAYED_STORAGE_KEY = 'alphabet-soup/played';
	var MAX_FRAME_SECONDS = 0.05;
	var WAVE_TRANSITION_SECONDS = 1.4;

	function readStoredMode() {
		try {
			var stored = window.localStorage.getItem( MODE_STORAGE_KEY );
			if ( stored && SOUP_MODES.indexOf( stored ) >= 0 ) {
				return stored;
			}
		} catch ( e ) {}
		return 'daily';
	}

	function storeMode( mode ) {
		try {
			window.localStorage.setItem( MODE_STORAGE_KEY, mode );
		} catch ( e ) {}
	}

	function readStoredSize() {
		try {
			var stored = window.localStorage.getItem( SIZE_STORAGE_KEY );
			if ( stored && SOUP_SIZES.indexOf( stored ) >= 0 ) {
				return stored;
			}
		} catch ( e ) {}
		return 'small';
	}

	function storeSize( size ) {
		try {
			window.localStorage.setItem( SIZE_STORAGE_KEY, size );
		} catch ( e ) {}
	}

	function readPlayedToday( dateSeed ) {
		try {
			var raw = window.localStorage.getItem( PLAYED_STORAGE_KEY );
			if ( ! raw ) {
				return {};
			}
			var parsed = JSON.parse( raw );
			if ( parsed.date !== dateSeed || ! Array.isArray( parsed.seeds ) ) {
				return {};
			}
			var out = {};
			parsed.seeds.forEach( function ( seed ) {
				out[ seed ] = true;
			} );
			return out;
		} catch ( e ) {
			return {};
		}
	}

	function markPlayed( dateSeed, seed ) {
		try {
			var seeds = readPlayedToday( dateSeed );
			seeds[ seed ] = true;
			window.localStorage.setItem(
				PLAYED_STORAGE_KEY,
				JSON.stringify( { date: dateSeed, seeds: Object.keys( seeds ) } )
			);
		} catch ( e ) {}
	}

	function formatClock( seconds ) {
		var whole = Math.max( 0, Math.floor( seconds ) );
		var mins = Math.floor( whole / 60 );
		var secs = whole % 60;
		return mins + ':' + String( secs ).padStart( 2, '0' );
	}

	function modeLabel( mode ) {
		return 'time-attack' === mode ? 'Time Attack' : 'Daily';
	}

	function modeHint( mode ) {
		return 'time-attack' === mode
			? '90 seconds on the clock — every word buys you more.'
			: DAILY_WAVE_COUNT + ' relaxed waves. No clock pressure, just streaks.';
	}

	function sizeLabel( size ) {
		if ( 'big' === size ) {
			return 'Big';
		}
		if ( 'medium' === size ) {
			return 'Medium';
		}
		return 'Small';
	}

	function sizeDims( size ) {
		var cells = sizeCells( size );
		return cells + '×' + cells;
	}

	/* ------------------------------------------------------------ *
	 * Game orchestrator.
	 * ------------------------------------------------------------ */

	function mountAlphabetSoup( container ) {
		var root = document.createElement( 'div' );
		root.className = 'soup';
		container.appendChild( root );

		var audio = createSoupAudio();

		var hud = document.createElement( 'div' );
		hud.className = 'soup__hud';
		var scoreEl = document.createElement( 'span' );
		scoreEl.className = 'soup__hud-score';
		var streakEl = document.createElement( 'span' );
		streakEl.className = 'soup__hud-streak';
		var timerEl = document.createElement( 'span' );
		timerEl.className = 'soup__hud-timer';
		var waveEl = document.createElement( 'span' );
		waveEl.className = 'soup__hud-wave';
		var soundToggle = document.createElement( 'button' );
		soundToggle.type = 'button';
		soundToggle.className = 'soup__hud-sound';
		function paintSoundToggle() {
			soundToggle.textContent = audio.isEnabled() ? '🔊' : '🔇';
			soundToggle.setAttribute(
				'aria-label',
				audio.isEnabled() ? 'Mute sound effects' : 'Unmute sound effects'
			);
		}
		paintSoundToggle();
		soundToggle.addEventListener( 'click', function () {
			audio.setEnabled( ! audio.isEnabled() );
			paintSoundToggle();
		} );
		hud.appendChild( scoreEl );
		hud.appendChild( streakEl );
		hud.appendChild( timerEl );
		hud.appendChild( waveEl );
		hud.appendChild( soundToggle );
		root.appendChild( hud );

		var body = document.createElement( 'div' );
		body.className = 'soup__body';
		root.appendChild( body );

		var stageEl = document.createElement( 'div' );
		stageEl.className = 'soup__stage';
		body.appendChild( stageEl );

		var canvas = document.createElement( 'canvas' );
		canvas.className = 'soup__canvas';
		stageEl.appendChild( canvas );
		var stage = createSoupStage( canvas );

		var wordsPanel = document.createElement( 'aside' );
		wordsPanel.className = 'soup__words';
		var wordsHeading = document.createElement( 'p' );
		wordsHeading.className = 'soup__words-heading';
		var wordsList = document.createElement( 'ul' );
		wordsList.className = 'soup__words-list';
		wordsPanel.appendChild( wordsHeading );
		wordsPanel.appendChild( wordsList );
		body.appendChild( wordsPanel );

		var overlay = document.createElement( 'div' );
		overlay.className = 'soup__overlay';
		overlay.hidden = true;
		root.appendChild( overlay );

		function showMessage( text ) {
			overlay.hidden = false;
			overlay.innerHTML = '';
			var p = document.createElement( 'p' );
			p.className = 'soup__overlay-message';
			p.textContent = text;
			overlay.appendChild( p );
		}
		showMessage( 'Warming up the soup…' );

		var disposed = false;
		var state = 'loading';
		var dictionary = null;
		var resizeObserver = null;

		var mode = readStoredMode();
		var size = readStoredSize();
		var dateSeed = formatDailySeed( new Date() );
		var seedString = runSeedString( dateSeed, mode, size );
		var officialRun = true;
		var scores = createSoupScore();
		var grid = null;
		var wave = 1;
		var foundWords = {};
		var foundCount = 0;
		var chipEls = [];
		var colorCounter = 0;
		var elapsedRun = 0;
		var timeLeft = TIME_ATTACK_START_SECONDS;
		var lastWholeSecond = -1;
		var waveTransition = -1;

		var anchor = null;
		var selection = [];

		function fieldWidth() {
			return stageEl.clientWidth || 640;
		}
		function fieldHeight() {
			return stageEl.clientHeight || 480;
		}

		function paintHud() {
			scoreEl.textContent = 'Score ' + scores.score;
			streakEl.textContent = scores.streak > 1 ? '×' + scores.streak : '';
			var clock =
				'time-attack' === mode ? formatClock( timeLeft ) : formatClock( elapsedRun );
			timerEl.textContent = '⏱ ' + clock;
			timerEl.classList.toggle(
				'soup__hud-timer--low',
				'time-attack' === mode && 'playing' === state && timeLeft <= LOW_TIME_SECONDS
			);
			waveEl.textContent = 'Wave ' + wave + ' · ' + modeLabel( mode );
		}

		function renderChips() {
			wordsList.innerHTML = '';
			chipEls = [];
			if ( ! grid ) {
				wordsHeading.textContent = '';
				return;
			}
			wordsHeading.textContent = 'Find ' + grid.words.length + ' words';
			grid.words.forEach( function ( entry ) {
				var li = document.createElement( 'li' );
				li.className = 'soup__word-chip';
				li.textContent = entry.word.toUpperCase();
				wordsList.appendChild( li );
				chipEls.push( li );
			} );
		}

		function markChipFound( index, color ) {
			var chip = chipEls[ index ];
			if ( ! chip ) {
				return;
			}
			chip.classList.add( 'soup__word-chip--found' );
			chip.style.borderColor = color;
			chip.style.color = color;
		}

		function startWave( nextWave ) {
			if ( ! dictionary ) {
				return;
			}
			wave = nextWave;
			waveTransition = -1;
			foundWords = {};
			foundCount = 0;
			var cfg = waveConfig( mode, size, wave );
			grid = generateSoup( {
				size: cfg.gridSize,
				wordCount: cfg.wordCount,
				minLen: cfg.minLen,
				maxLen: cfg.maxLen,
				dictionary: dictionary,
				rng: waveRng( seedString, wave ),
			} );
			stage.relayout( fieldWidth(), fieldHeight() );
			stage.setGrid( grid );
			renderChips();
			stage.banner( 'Wave ' + wave, fieldWidth() / 2, fieldHeight() / 2 );
			paintHud();
		}

		function waveCleared() {
			recordWaveClear( scores, wave );
			audio.waveClear();
			stage.confetti( fieldWidth(), WORD_COLORS );
			if ( 'time-attack' === mode ) {
				timeLeft += TIME_ATTACK_WAVE_BONUS_SECONDS;
			}
			if ( 'daily' === mode && isFinalDailyWave( wave ) ) {
				stage.banner( 'Soup finished!', fieldWidth() / 2, fieldHeight() / 2 );
				waveTransition = -1;
				window.setTimeout( function () {
					if ( ! disposed && 'playing' === state ) {
						gameOver( true );
					}
				}, 1200 );
				return;
			}
			waveTransition = WAVE_TRANSITION_SECONDS;
			paintHud();
		}

		function resolveSelection( cells ) {
			if ( ! grid || cells.length < 2 ) {
				return;
			}
			var index = selectionMatches( grid, cells );
			if ( index >= 0 && ! foundWords[ index ] ) {
				foundWords[ index ] = true;
				foundCount++;
				var entry = grid.words[ index ];
				var color = WORD_COLORS[ colorCounter % WORD_COLORS.length ];
				colorCounter++;
				var points = recordFind( scores, entry.word.length );
				stage.lockWord( entry.cells, color );
				markChipFound( index, color );
				audio.found( entry.word.length );
				var mid = entry.cells[ Math.floor( entry.cells.length / 2 ) ];
				var midPoint = stage.cellCenter( mid );
				stage.floatScore( midPoint.x, midPoint.y - 8, '+' + points, color );
				entry.cells.forEach( function ( c ) {
					var p = stage.cellCenter( c );
					stage.burstAt( p.x, p.y, color );
				} );
				if ( 'time-attack' === mode ) {
					timeLeft += TIME_ATTACK_WORD_BONUS_SECONDS;
				}
				if ( foundCount >= grid.words.length ) {
					waveCleared();
				}
			} else {
				recordMissSelection( scores );
				stage.flashInvalid( cells );
				audio.invalid();
			}
			paintHud();
		}

		function gameOver( completed ) {
			state = 'over';
			anchor = null;
			selection = [];
			stage.clearSelection();
			audio.gameOver();
			var row = buildSoupScoreRow( scores, {
				mode: mode,
				size: sizeDims( size ),
				wave: wave,
				elapsedSeconds: elapsedRun,
			} );

			overlay.hidden = false;
			overlay.innerHTML = '';
			var panel = document.createElement( 'div' );
			panel.className = 'soup__over-panel';

			var heading = document.createElement( 'p' );
			heading.className = 'soup__over-heading';
			heading.textContent = completed ? 'Soup finished!' : 'Time’s up!';
			panel.appendChild( heading );

			var stats = document.createElement( 'p' );
			stats.className = 'soup__over-stats';
			stats.textContent =
				'Score ' + row.score + ' — ' + scores.wordsFound + ' words, ' +
				accuracyPercent( scores ) + '% accuracy, best streak ' + scores.bestStreak +
				', wave ' + wave + '.';
			panel.appendChild( stats );

			if ( officialRun ) {
				var shareData = {
					gameTitle: 'Alphabet Soup',
					puzzleLabel: modeLabel( mode ) + ' · ' + sizeDims( size ) + ' · ' + dateSeed,
					score: row.score,
					scoreLabel: 'points',
					stats: [
						{ label: 'Words', value: String( scores.wordsFound ) },
						{ label: 'WPM', value: String( row.meta.wpm ) },
						{ label: 'Accuracy', value: accuracyPercent( scores ) + '%' },
						{ label: 'Streak', value: String( scores.bestStreak ) },
						{ label: 'Wave', value: String( wave ) },
					],
					footer: 'Alphabet Soup · WpApp',
				};
				var shareCanvas = document.createElement( 'canvas' );
				shareCanvas.className = 'soup__share-canvas';
				renderShareCard( shareCanvas, shareData );
				panel.appendChild( shareCanvas );

				var shareRow = document.createElement( 'div' );
				shareRow.className = 'soup__share-actions';
				var shareStatus = document.createElement( 'span' );
				shareStatus.className = 'soup__share-status';
				var shareButton = document.createElement( 'button' );
				shareButton.type = 'button';
				shareButton.className = 'soup__button soup__button--primary';
				shareButton.textContent = 'Share card';
				shareButton.addEventListener( 'click', function () {
					shareStatus.textContent = '';
					shareScoreCard(
						shareCanvas,
						'alphabet-soup-' + dateSeed + '.png',
						'Alphabet Soup'
					).then( function ( outcome ) {
						if ( disposed ) {
							return;
						}
						if ( 'shared' === outcome ) {
							shareStatus.textContent = 'Shared!';
						} else if ( 'copied' === outcome ) {
							shareStatus.textContent = 'Card copied to your clipboard.';
						} else if ( 'downloaded' === outcome ) {
							shareStatus.textContent = 'Card saved as an image.';
						} else {
							shareStatus.textContent = 'The card could not be shared.';
						}
					} );
				} );
				shareRow.appendChild( shareButton );
				shareRow.appendChild( shareStatus );
				panel.appendChild( shareRow );
			} else {
				var replayNote = document.createElement( 'p' );
				replayNote.className = 'soup__over-replay';
				replayNote.textContent =
					'Replay run — share cards only go to the first run of each puzzle. A fresh soup is served tomorrow.';
				panel.appendChild( replayNote );
			}

			var saveNote = document.createElement( 'p' );
			saveNote.className = 'soup__over-save';
			if ( config.currentUser ) {
				saveNote.textContent = 'Saving your score…';
				submitScoreToServer( row ).then(
					function () {
						saveNote.textContent = 'Score saved to the leaderboard.';
					},
					function () {
						saveNote.textContent = 'Your score could not be saved.';
					}
				);
			} else {
				var loginLink = document.createElement( 'a' );
				loginLink.href = config.loginUrl || '#';
				loginLink.textContent = 'Log in';
				saveNote.textContent = '';
				saveNote.appendChild( loginLink );
				saveNote.appendChild(
					document.createTextNode( ' to save your score to the leaderboard.' )
				);
			}
			panel.appendChild( saveNote );

			var actions = document.createElement( 'div' );
			actions.className = 'soup__over-actions';
			var again = document.createElement( 'button' );
			again.type = 'button';
			again.className = 'soup__button';
			again.textContent = 'Play again';
			again.addEventListener( 'click', function () {
				requestRun( mode, size );
			} );
			actions.appendChild( again );
			var changeMode = document.createElement( 'button' );
			changeMode.type = 'button';
			changeMode.className = 'soup__button';
			changeMode.textContent = 'Change mode';
			changeMode.addEventListener( 'click', function () {
				showMenu();
			} );
			actions.appendChild( changeMode );
			panel.appendChild( actions );

			overlay.appendChild( panel );
		}

		function startRun( picked, pickedSize ) {
			mode = picked;
			size = pickedSize;
			storeMode( picked );
			storeSize( pickedSize );
			seedString = runSeedString( dateSeed, mode, size );
			officialRun = ! readPlayedToday( dateSeed )[ seedString ];
			markPlayed( dateSeed, seedString );
			scores = createSoupScore();
			colorCounter = 0;
			elapsedRun = 0;
			timeLeft = TIME_ATTACK_START_SECONDS;
			lastWholeSecond = -1;
			overlay.hidden = true;
			overlay.innerHTML = '';
			state = 'playing';
			stage.clearFx();
			startWave( 1 );
		}

		function requestRun( picked, pickedSize ) {
			var seed = runSeedString( dateSeed, picked, pickedSize );
			if ( readPlayedToday( dateSeed )[ seed ] ) {
				var proceed = window.confirm(
					'You already played today’s ' + modeLabel( picked ) + ' (' +
						sizeDims( pickedSize ) +
						'). The word positions can be memorized, so replays don’t earn a share card — that stays with your first run. Replay anyway?'
				);
				if ( ! proceed || disposed ) {
					return;
				}
			}
			startRun( picked, pickedSize );
		}

		function showMenu() {
			state = 'menu';
			grid = null;
			renderChips();
			paintHud();
			overlay.hidden = false;
			overlay.innerHTML = '';

			var panel = document.createElement( 'div' );
			panel.className = 'soup__over-panel soup__menu';

			var heading = document.createElement( 'p' );
			heading.className = 'soup__over-heading';
			heading.textContent = 'Alphabet Soup';
			panel.appendChild( heading );

			var tagline = document.createElement( 'p' );
			tagline.className = 'soup__over-stats';
			tagline.textContent =
				'One pot, whole world: everyone gets the same soup today (' + dateSeed +
				'). Drag across the letters to fish the words out.';
			panel.appendChild( tagline );

			var sizes = document.createElement( 'div' );
			sizes.className = 'soup__menu-sizes';
			SOUP_SIZES.forEach( function ( option ) {
				var chip = document.createElement( 'button' );
				chip.type = 'button';
				chip.className = 'soup__size-chip';
				if ( option === size ) {
					chip.classList.add( 'soup__size-chip--current' );
				}
				chip.textContent = sizeLabel( option ) + ' · ' + sizeDims( option );
				chip.addEventListener( 'click', function ( e ) {
					e.stopPropagation();
					size = option;
					storeSize( option );
					showMenu();
				} );
				sizes.appendChild( chip );
			} );
			panel.appendChild( sizes );

			var played = readPlayedToday( dateSeed );
			var options = document.createElement( 'div' );
			options.className = 'soup__menu-options';
			SOUP_MODES.forEach( function ( option ) {
				var button = document.createElement( 'button' );
				button.type = 'button';
				button.className = 'soup__menu-option';
				if ( option === mode ) {
					button.classList.add( 'soup__menu-option--current' );
				}
				var label = document.createElement( 'span' );
				label.className = 'soup__menu-option-label';
				label.textContent = modeLabel( option );
				button.appendChild( label );
				var hint = document.createElement( 'span' );
				hint.className = 'soup__menu-option-hint';
				hint.textContent = modeHint( option );
				button.appendChild( hint );
				if ( played[ runSeedString( dateSeed, option, size ) ] ) {
					var note = document.createElement( 'span' );
					note.className = 'soup__menu-option-played';
					note.textContent = 'Played today — replays aren’t shareable';
					button.appendChild( note );
				}
				button.addEventListener( 'click', function ( e ) {
					e.stopPropagation();
					requestRun( option, size );
				} );
				options.appendChild( button );
			} );
			panel.appendChild( options );

			overlay.appendChild( panel );
		}

		function pause() {
			if ( 'playing' !== state ) {
				return;
			}
			state = 'paused';
			anchor = null;
			selection = [];
			stage.clearSelection();
			showMessage( 'Paused — click to resume.' );
		}

		function resume() {
			if ( 'paused' !== state ) {
				return;
			}
			state = 'playing';
			overlay.hidden = true;
		}

		overlay.addEventListener( 'click', function () {
			if ( 'paused' === state ) {
				resume();
			}
		} );

		var lastFrameTime = null;
		function frame( now ) {
			if ( disposed ) {
				return;
			}
			var dt = null === lastFrameTime ? 0 : ( now - lastFrameTime ) / 1000;
			lastFrameTime = now;
			dt = Math.min( MAX_FRAME_SECONDS, Math.max( 0, dt ) );

			if ( 'playing' === state ) {
				elapsedRun += dt;
				if ( waveTransition > 0 ) {
					waveTransition -= dt;
					if ( waveTransition <= 0 ) {
						startWave( wave + 1 );
					}
				}
				if ( 'time-attack' === mode && waveTransition <= 0 ) {
					timeLeft -= dt;
					var whole = Math.ceil( timeLeft );
					if ( whole !== lastWholeSecond ) {
						lastWholeSecond = whole;
						if ( timeLeft > 0 && timeLeft <= LOW_TIME_SECONDS ) {
							audio.tick();
						}
						paintHud();
					}
					if ( timeLeft <= 0 ) {
						timeLeft = 0;
						gameOver( false );
					}
				} else if ( 'time-attack' !== mode ) {
					var wholeSec = Math.floor( elapsedRun );
					if ( wholeSec !== lastWholeSecond ) {
						lastWholeSecond = wholeSec;
						paintHud();
					}
				}
			}

			stage.render( dt );
			window.requestAnimationFrame( frame );
		}

		function canvasPoint( event ) {
			var rect = canvas.getBoundingClientRect();
			if ( rect.width <= 0 || rect.height <= 0 ) {
				return null;
			}
			return {
				x: ( ( event.clientX - rect.left ) / rect.width ) * fieldWidth(),
				y: ( ( event.clientY - rect.top ) / rect.height ) * fieldHeight(),
			};
		}

		function onPointerDown( event ) {
			if ( 'playing' !== state || ! grid ) {
				return;
			}
			var point = canvasPoint( event );
			var cell = point ? stage.cellAt( point.x, point.y ) : null;
			if ( ! cell ) {
				return;
			}
			canvas.setPointerCapture( event.pointerId );
			anchor = cell;
			selection = [ cell ];
			stage.showSelection( selection );
			audio.cellTouch( 0 );
		}

		function onPointerMove( event ) {
			if ( ! anchor || ! grid ) {
				return;
			}
			var point = canvasPoint( event );
			if ( ! point ) {
				return;
			}
			var cell = stage.cellAt( point.x, point.y );
			if ( ! cell ) {
				return;
			}
			var next = lineCells( anchor, cell, grid.size );
			var lastCurrent = selection[ selection.length - 1 ];
			var lastNext = next[ next.length - 1 ];
			if (
				next.length !== selection.length ||
				! lastCurrent ||
				lastNext.row !== lastCurrent.row ||
				lastNext.col !== lastCurrent.col
			) {
				if ( next.length > selection.length ) {
					audio.cellTouch( next.length - 1 );
				}
				selection = next;
				stage.showSelection( selection );
			}
		}

		function onPointerUp() {
			if ( ! anchor ) {
				return;
			}
			var cells = selection;
			anchor = null;
			selection = [];
			stage.clearSelection();
			if ( 'playing' === state ) {
				resolveSelection( cells );
			}
		}

		canvas.addEventListener( 'pointerdown', onPointerDown );
		canvas.addEventListener( 'pointermove', onPointerMove );
		canvas.addEventListener( 'pointerup', onPointerUp );
		canvas.addEventListener( 'pointercancel', onPointerUp );
		canvas.style.touchAction = 'none';

		window.addEventListener( 'blur', pause );

		resizeObserver = new ResizeObserver( function () {
			stage.relayout( fieldWidth(), fieldHeight() );
		} );
		resizeObserver.observe( stageEl );

		var wordsUrl = config.wordsUrl || '';
		if ( '' === wordsUrl ) {
			showMessage( 'Alphabet Soup is missing its dictionary URL.' );
			return function () {};
		}

		loadDictionary( wordsUrl )
			.then( function ( loaded ) {
				if ( disposed ) {
					return;
				}
				dictionary = loaded;
				paintHud();
				showMenu();
				window.requestAnimationFrame( frame );
			} )
			.catch( function ( err ) {
				if ( disposed ) {
					return;
				}
				showMessage( err && err.message ? err.message : 'Alphabet Soup could not start.' );
			} );

		return function teardown() {
			if ( disposed ) {
				return;
			}
			disposed = true;
			audio.dispose();
			window.removeEventListener( 'blur', pause );
			if ( resizeObserver ) {
				resizeObserver.disconnect();
			}
			canvas.removeEventListener( 'pointerdown', onPointerDown );
			canvas.removeEventListener( 'pointermove', onPointerMove );
			canvas.removeEventListener( 'pointerup', onPointerUp );
			canvas.removeEventListener( 'pointercancel', onPointerUp );
			root.remove();
		};
	}

	function boot() {
		var container = document.getElementById( 'alphabet-soup-root' );
		if ( ! container ) {
			return;
		}
		mountAlphabetSoup( container );
	}

	if ( 'loading' === document.readyState ) {
		document.addEventListener( 'DOMContentLoaded', boot );
	} else {
		boot();
	}
} )();
