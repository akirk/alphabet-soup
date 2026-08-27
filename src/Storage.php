<?php

namespace AlphabetSoup;

/**
 * Leaderboard storage — one `alphabet_soup_score` post per finished
 * run, `post_author` is the player. `score` is stored as its own
 * numeric post meta key (so `orderby=meta_value_num` sorts the
 * leaderboard); the flexible per-run fields (mode, size, words, wpm,
 * accuracy, streak, wave, time) live in a single JSON `meta` post
 * meta field, mirroring how OpenStation's games table keeps a fixed
 * `score` column plus a flexible JSON `meta` blob.
 *
 * A private CPT rather than a custom table: no schema/dbDelta to
 * maintain, and WordPress-native storage is what wp-app's own
 * scaffold recommends before reaching for BaseStorage.
 */
class Storage {

	const POST_TYPE = 'alphabet_soup_score';

	public function register_post_type(): void {
		register_post_type( self::POST_TYPE, [
			'label'           => __( 'Alphabet Soup Scores', 'alphabet-soup' ),
			'public'          => false,
			'show_ui'         => false,
			'has_archive'     => false,
			'rewrite'         => false,
			'query_var'       => false,
			'capability_type' => 'post',
			'supports'        => [ 'title', 'author' ],
		] );
	}

	/**
	 * Bound and sanitize a score meta blob: flat map, slug keys,
	 * scalar values only, capped so a hostile client can't fatten the
	 * table. Mirrors OpenStation's `openstation_games_sanitize_score_meta()`.
	 *
	 * @param mixed $meta Raw caller input.
	 * @return array Sanitized flat map.
	 */
	public function sanitize_meta( $meta ) {
		if ( ! is_array( $meta ) ) {
			return [];
		}
		$out = [];
		foreach ( $meta as $key => $value ) {
			if ( count( $out ) >= 20 ) {
				break;
			}
			$key = sanitize_key( (string) $key );
			if ( '' === $key ) {
				continue;
			}
			if ( is_int( $value ) || is_float( $value ) ) {
				$out[ $key ] = $value + 0;
			} elseif ( is_bool( $value ) ) {
				$out[ $key ] = $value;
			} elseif ( is_string( $value ) ) {
				$out[ $key ] = mb_substr( sanitize_text_field( $value ), 0, 200 );
			}
		}
		return $out;
	}

	/**
	 * Persist a finished run. Client-asserted score/meta — the
	 * arcade trust model: the server clamps and sanitizes what it
	 * can, same as OpenStation's games store.
	 *
	 * @param int   $user_id Player.
	 * @param int   $score   Non-negative sort value.
	 * @param array $meta    Flexible per-run fields.
	 * @return int Post id.
	 */
	public function save_score( $user_id, $score, $meta = [] ) {
		$score = max( 0, (int) $score );
		$meta  = $this->sanitize_meta( $meta );

		$post_id = wp_insert_post( [
			'post_type'   => self::POST_TYPE,
			'post_status' => 'publish',
			'post_author' => (int) $user_id,
			/* translators: %d: score. */
			'post_title'  => sprintf( __( 'Score %d', 'alphabet-soup' ), $score ),
		], true );

		if ( is_wp_error( $post_id ) ) {
			return 0;
		}

		update_post_meta( $post_id, 'score', $score );
		update_post_meta( $post_id, 'meta', wp_json_encode( $meta ) );

		return (int) $post_id;
	}

	/**
	 * Leaderboard query.
	 *
	 * @param array $args {
	 *     @type int    $page     1-based page. Default 1.
	 *     @type int    $per_page Rows per page, 1-100. Default 25.
	 *     @type string $orderby  'score' | 'created'. Default 'score'.
	 *     @type string $order    'asc' | 'desc'. Default 'desc'.
	 * }
	 * @return array{ rows: array[], total: int }
	 */
	public function get_scores( $args = [] ) {
		$page     = max( 1, (int) ( $args['page'] ?? 1 ) );
		$per_page = min( 100, max( 1, (int) ( $args['per_page'] ?? 25 ) ) );
		$order    = ( 'asc' === strtolower( (string) ( $args['order'] ?? 'desc' ) ) ) ? 'ASC' : 'DESC';
		$orderby  = ( 'created' === ( $args['orderby'] ?? '' ) ) ? 'date' : 'meta_value_num';

		$query_args = [
			'post_type'      => self::POST_TYPE,
			'post_status'    => 'publish',
			'posts_per_page' => $per_page,
			'paged'          => $page,
			'orderby'        => $orderby,
			'order'          => $order,
			'no_found_rows'  => false,
		];
		if ( 'meta_value_num' === $orderby ) {
			$query_args['meta_key'] = 'score'; // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
		}

		$query = new \WP_Query( $query_args );

		return [
			'rows'  => array_map( [ $this, 'shape_score' ], $query->posts ),
			'total' => (int) $query->found_posts,
		];
	}

	/**
	 * Shape a score post for the wire: camelCase keys + player
	 * display name and avatar.
	 *
	 * @param \WP_Post $post Score post.
	 * @return array
	 */
	public function shape_score( $post ) {
		$user_id = (int) $post->post_author;
		$user    = get_userdata( $user_id );
		$meta    = json_decode( (string) get_post_meta( $post->ID, 'meta', true ), true );

		return [
			'id'         => (int) $post->ID,
			'userId'     => $user_id,
			'userName'   => $user ? $user->display_name : __( 'Former user', 'alphabet-soup' ),
			'userAvatar' => get_avatar_url( $user_id, [ 'size' => 48 ] ),
			'score'      => (int) get_post_meta( $post->ID, 'score', true ),
			'meta'       => is_array( $meta ) ? $meta : [],
			'createdAt'  => $post->post_date,
		];
	}
}
