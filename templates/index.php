<!DOCTYPE html>
<html <?php wp_app_language_attributes(); ?>>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title><?php wp_app_title( 'Alphabet Soup' ); ?></title>
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
				<a href="<?php echo esc_url( home_url( '/alphabet-soup/leaderboard' ) ); ?>"><?php esc_html_e( 'Leaderboard', 'alphabet-soup' ); ?></a>
			</nav>
		</div>
		<div class="soup-page__stage">
			<div id="alphabet-soup-root" style="flex:1;width:100%;"></div>
		</div>
	</div>

	<?php wp_app_body_close(); ?>
</body>
</html>
