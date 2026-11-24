<?php

namespace AlphabetSoup;

use WpApp\WpApp;
use WpApp\BaseApp;

class App extends BaseApp {
	public function __construct() {
		$this->storage = new Storage();

		// See https://github.com/akirk/wp-app for documentation.
		$this->app = new WpApp( $this->get_template_dir(), $this->get_url_path(), [
			// Everyone can browse the leaderboard; only a logged-in
			// player's own runs get saved (see register_rest_endpoints()).
			'require_login' => false,

			// App identity
			'app_name'            => $this->get_plugin_name(),
			'app_name_textdomain' => 'alphabet-soup',
			'my_apps'             => true,
		] );

		add_action( 'template_redirect', [ $this, 'maybe_setup_assets' ] );
	}

	protected function get_url_path(): string {
		return 'alphabet-soup';
	}

	protected function get_template_dir(): string {
		return dirname( __DIR__ ) . '/templates';
	}

	protected function get_plugin_name(): string {
		if ( ! function_exists( 'get_file_data' ) ) {
			return 'Alphabet Soup';
		}

		$plugin_data = get_file_data( dirname( __DIR__ ) . '/alphabet-soup.php', [ 'name' => 'Plugin Name' ] );

		return $plugin_data['name'] ?: 'Alphabet Soup';
	}

	protected function setup_database(): void {
		add_action( 'init', [ $this->storage, 'register_post_type' ] );
	}

	protected function setup_routes(): void {
		$this->app->route( '' );               // -> templates/index.php
		$this->app->route( 'leaderboard' );     // -> templates/leaderboard.php

		add_action( 'rest_api_init', [ $this, 'register_rest_endpoints' ] );
	}

	protected function setup_menu(): void {
		$this->app->add_menu_item( 'leaderboard', __( 'Leaderboard', 'alphabet-soup' ), home_url( '/alphabet-soup/leaderboard' ) );
	}

	public function maybe_setup_assets(): void {
		if ( ! $this->app->is_app_request() ) {
			return;
		}

		wp_app_enqueue_style(
			'alphabet-soup',
			plugins_url( 'assets/css/alphabet-soup.css', dirname( __FILE__ ) ),
			[],
			'1.0.0',
			$this->get_url_path()
		);

		if ( 'leaderboard' === trim( (string) get_query_var( 'wp_app_request' ), '/' ) ) {
			return;
		}

		$current_user = null;
		if ( is_user_logged_in() ) {
			$user         = wp_get_current_user();
			$current_user = [
				'id'   => $user->ID,
				'name' => $user->display_name,
			];
		}

		wp_app_add_inline_script(
			'alphabet-soup-config',
			'window.AlphabetSoupConfig = ' . wp_json_encode( [
				'restUrl'     => esc_url_raw( rest_url() ),
				'restNonce'   => wp_create_nonce( 'wp_rest' ),
				'wordsUrl'    => $this->get_words_url(),
				'currentUser' => $current_user,
				'loginUrl'    => wp_login_url( home_url( '/alphabet-soup/' ) ),
			] ) . ';',
			true,
			$this->get_url_path()
		);

		wp_app_enqueue_script(
			'alphabet-soup',
			plugins_url( 'assets/js/alphabet-soup.js', dirname( __FILE__ ) ),
			[],
			'1.0.0',
			true,
			$this->get_url_path()
		);
	}

	/**
	 * URL of the shared word-search dictionary asset, cache-busted on
	 * content change. Ported verbatim from OpenStation's
	 * `assets/games/words.txt` — the word list is what lets the
	 * seeded daily puzzle be identical for every player.
	 */
	protected function get_words_url(): string {
		$words_file = dirname( __DIR__ ) . '/assets/words.txt';
		$words_url  = plugins_url( 'assets/words.txt', dirname( __FILE__ ) );
		if ( file_exists( $words_file ) ) {
			$words_url = add_query_arg( 'ver', (string) filemtime( $words_file ), $words_url );
		}
		return $words_url;
	}

	/**
	 * Register the leaderboard REST routes. Same trust model as
	 * OpenStation's games REST API: a player can only submit their
	 * own score, and the server clamps/sanitizes it
	 * (see Storage::sanitize_meta()).
	 */
	public function register_rest_endpoints(): void {
		register_rest_route(
			'alphabet-soup/v1',
			'/scores',
			[
				[
					'methods'             => 'GET',
					'callback'            => [ $this, 'rest_get_scores' ],
					'permission_callback' => '__return_true',
					'args'                => [
						'page'     => [ 'type' => 'integer', 'default' => 1 ],
						'per_page' => [ 'type' => 'integer', 'default' => 25 ],
						'orderby'  => [ 'type' => 'string', 'default' => 'score', 'enum' => [ 'score', 'created' ] ],
						'order'    => [ 'type' => 'string', 'default' => 'desc', 'enum' => [ 'asc', 'desc' ] ],
					],
				],
				[
					'methods'             => 'POST',
					'callback'            => [ $this, 'rest_submit_score' ],
					'permission_callback' => function () {
						return is_user_logged_in()
							? true
							: new \WP_Error( 'alphabet_soup_unauthenticated', __( 'You must be logged in to save a score.', 'alphabet-soup' ), [ 'status' => 401 ] );
					},
					'args'                => [
						'score' => [ 'type' => 'integer', 'required' => true, 'minimum' => 0 ],
						'meta'  => [ 'type' => 'object', 'default' => [] ],
					],
				],
			]
		);
	}

	public function rest_get_scores( \WP_REST_Request $request ) {
		$result = $this->storage->get_scores( [
			'page'     => (int) $request->get_param( 'page' ),
			'per_page' => (int) $request->get_param( 'per_page' ),
			'orderby'  => (string) $request->get_param( 'orderby' ),
			'order'    => (string) $request->get_param( 'order' ),
		] );

		return rest_ensure_response( [
			'scores' => $result['rows'],
			'total'  => $result['total'],
		] );
	}

	public function rest_submit_score( \WP_REST_Request $request ) {
		$id = $this->storage->save_score(
			get_current_user_id(),
			(int) $request->get_param( 'score' ),
			(array) $request->get_param( 'meta' )
		);

		return rest_ensure_response( [ 'id' => $id ] );
	}

	public function activate(): void {
		// The CPT is `rewrite => false`, so it adds nothing to flush,
		// but registering it before flushing keeps activation order
		// consistent with a CPT that later gains rewrite rules.
		$this->storage->register_post_type();
		flush_rewrite_rules();
	}

	public function deactivate(): void {
		flush_rewrite_rules();
	}
}
