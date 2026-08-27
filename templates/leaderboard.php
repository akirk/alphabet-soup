<?php

use AlphabetSoup\Storage;

$storage = new Storage();
$result  = $storage->get_scores( [ 'per_page' => 50, 'orderby' => 'score', 'order' => 'desc' ] );
?>
<!DOCTYPE html>
<html <?php wp_app_language_attributes(); ?>>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title><?php wp_app_title( __( 'Leaderboard', 'alphabet-soup' ) ); ?></title>
	<?php wp_app_head(); ?>
</head>
<body class="wp-app-body">
	<?php wp_app_body_open(); ?>

	<div class="soup-page">
		<div class="soup-page__bar">
			<p class="soup-page__title">
				<a href="<?php echo esc_url( home_url( '/alphabet-soup/' ) ); ?>"><?php esc_html_e( 'Alphabet Soup', 'alphabet-soup' ); ?></a>
			</p>
			<nav class="soup-page__nav">
				<a href="<?php echo esc_url( home_url( '/alphabet-soup/' ) ); ?>"><?php esc_html_e( 'Play', 'alphabet-soup' ); ?></a>
			</nav>
		</div>

		<div class="soup-leaderboard">
			<h1><?php esc_html_e( 'Leaderboard', 'alphabet-soup' ); ?></h1>
			<p><?php esc_html_e( 'Top runs across every mode and pot size.', 'alphabet-soup' ); ?></p>

			<?php if ( empty( $result['rows'] ) ) : ?>
				<p><?php esc_html_e( 'No scores yet — be the first to finish a soup.', 'alphabet-soup' ); ?></p>
			<?php else : ?>
				<table>
					<thead>
						<tr>
							<th><?php esc_html_e( 'Player', 'alphabet-soup' ); ?></th>
							<th><?php esc_html_e( 'Score', 'alphabet-soup' ); ?></th>
							<th><?php esc_html_e( 'Mode', 'alphabet-soup' ); ?></th>
							<th><?php esc_html_e( 'Size', 'alphabet-soup' ); ?></th>
							<th><?php esc_html_e( 'Words', 'alphabet-soup' ); ?></th>
							<th><?php esc_html_e( 'WPM', 'alphabet-soup' ); ?></th>
							<th><?php esc_html_e( 'Accuracy', 'alphabet-soup' ); ?></th>
						</tr>
					</thead>
					<tbody>
						<?php foreach ( $result['rows'] as $row ) : ?>
							<tr>
								<td>
									<img class="avatar" src="<?php echo esc_url( $row['userAvatar'] ); ?>" alt="" width="24" height="24">
									<?php echo esc_html( $row['userName'] ); ?>
								</td>
								<td class="is-numeric"><?php echo esc_html( number_format_i18n( $row['score'] ) ); ?></td>
								<td><?php echo esc_html( $row['meta']['mode'] ?? '' ); ?></td>
								<td><?php echo esc_html( $row['meta']['size'] ?? '' ); ?></td>
								<td class="is-numeric"><?php echo esc_html( $row['meta']['words'] ?? '' ); ?></td>
								<td class="is-numeric"><?php echo esc_html( $row['meta']['wpm'] ?? '' ); ?></td>
								<td class="is-numeric"><?php echo esc_html( isset( $row['meta']['accuracy'] ) ? $row['meta']['accuracy'] . '%' : '' ); ?></td>
							</tr>
						<?php endforeach; ?>
					</tbody>
				</table>
			<?php endif; ?>
		</div>
	</div>

	<?php wp_app_body_close(); ?>
</body>
</html>
