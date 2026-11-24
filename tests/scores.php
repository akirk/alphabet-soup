<?php
/** Run only on disposable test WordPress: ALPHABET_SOUP_TESTS=1 wp eval-file tests/scores.php. */
if ( ! defined( 'WP_CLI' ) || ! WP_CLI || getenv( 'ALPHABET_SOUP_TESTS' ) !== '1' ) {
    throw new RuntimeException( 'Use the disposable WordPress environment from the Tests workflow.' );
}
$checks = 0;
$check = static function ( $condition, $message ) use ( &$checks ) {
    if ( ! $condition ) { throw new RuntimeException( $message ); }
    $checks++;
};
$request = static function ( $method, array $params ) {
    $request = new WP_REST_Request( $method, '/alphabet-soup/v1/scores' );
    if ( $method === 'POST' ) {
        $request->set_header( 'content-type', 'application/json' );
        $request->set_body( wp_json_encode( $params ) );
    } else {
        $request->set_query_params( $params );
    }
    return rest_do_request( $request );
};
$current_user = get_current_user_id();
$users = []; $posts = [];
try {
    foreach ( [ 'First player', 'Second player' ] as $name ) {
        $id = wp_insert_user( [ 'user_login' => 'soup_test_' . wp_generate_uuid4(),
            'user_pass' => wp_generate_password(), 'display_name' => $name, 'role' => 'subscriber' ] );
        $check( ! is_wp_error( $id ), 'Could not create the player fixture.' );
        $users[] = $id;
    }
    $before = (int) wp_count_posts( \AlphabetSoup\Storage::POST_TYPE )->publish;

    // Anonymous requests must not persist a run, even with an otherwise valid score.
    wp_set_current_user( 0 );
    $response = $request( 'POST', [ 'score' => 100, 'meta' => [ 'mode' => 'classic' ] ] );
    $check( $response->get_status() === 401 && $response->get_data()['code'] === 'alphabet_soup_unauthenticated', 'Anonymous score submission must return the specific 401 denial.' );
    $check( (int) wp_count_posts( \AlphabetSoup\Storage::POST_TYPE )->publish === $before, 'Rejected anonymous submission must not create a leaderboard entry.' );

    // A client cannot assign a run to another player; the logged-in reader owns it.
    wp_set_current_user( $users[0] );
    $response = $request( 'POST', [ 'score' => 2, 'user_id' => $users[1],
        'meta' => [ 'Mode!' => '<b>classic</b>', 'wpm' => 42, 'ranked' => true, 'note' => '<b>steady</b>', 'nested' => [ 'untrusted' => 'value' ] ] ] );
    $check( $response->get_status() === 200 && $response->get_data()['id'] > 0, 'A logged-in subscriber must be able to save a finished run.' );
    $posts[] = $response->get_data()['id'];
    $check( (int) get_post( $posts[0] )->post_author === $users[0], 'The stored score must belong to the logged-in player, not the submitted user_id.' );
    $check( (int) get_post_meta( $posts[0], 'score', true ) === 2, 'The submitted score must be persisted.' );
    $check( json_decode( get_post_meta( $posts[0], 'meta', true ), true ) === [ 'mode' => 'classic', 'wpm' => 42, 'ranked' => true, 'note' => 'steady' ], 'Run metadata must sanitize slug keys/text and omit nested client data.' );

    // Invalid scores must be rejected by the real route schema, not clamped into a new run.
    $response = $request( 'POST', [ 'score' => -1 ] );
    $check( $response->get_status() === 400 && $response->get_data()['code'] === 'rest_invalid_param', 'A negative score must fail route validation.' );
    $check( (int) wp_count_posts( \AlphabetSoup\Storage::POST_TYPE )->publish === $before + 1, 'Invalid input must not write a second run.' );

    wp_set_current_user( $users[1] );
    $response = $request( 'POST', [ 'score' => 12, 'meta' => [ 'mode' => 'classic' ] ] );
    $check( $response->get_status() === 200 && $response->get_data()['id'] > 0, 'The second player must be able to submit a score.' );
    $posts[] = $response->get_data()['id'];

    // Public reads must rank numbers, not strings: 12 comes before 2 in descending order.
    wp_set_current_user( 0 );
    $response = $request( 'GET', [ 'per_page' => 1 ] );
    $data = $response->get_data();
    $check( $response->get_status() === 200 && $data['total'] === $before + 2, 'Anonymous readers must see the leaderboard with the exact run count.' );
    $check( count( $data['scores'] ) === 1 && $data['scores'][0]['id'] === $posts[1] && $data['scores'][0]['score'] === 12 && $data['scores'][0]['userId'] === $users[1] && $data['scores'][0]['userName'] === 'Second player', 'First public page must contain the numerically highest score and its actual player.' );
    $data = $request( 'GET', [ 'per_page' => 1, 'page' => 2 ] )->get_data();
    $check( count( $data['scores'] ) === 1 && $data['scores'][0]['id'] === $posts[0] && $data['scores'][0]['score'] === 2 && $data['scores'][0]['meta'] === [ 'mode' => 'classic', 'wpm' => 42, 'ranked' => true, 'note' => 'steady' ], 'Second public page must retain the other run and sanitized metadata.' );
    WP_CLI::success( $checks . ' score REST checks passed: authentication, ownership, metadata, validation and numeric pagination.' );
} finally {
    wp_set_current_user( $current_user );
    foreach ( $posts as $id ) { wp_delete_post( $id, true ); }
    require_once ABSPATH . 'wp-admin/includes/user.php';
    foreach ( $users as $id ) { wp_delete_user( $id ); }
}
