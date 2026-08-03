alter table public.app_users
  add column if not exists profile_photo_data text;

alter table public.app_users
  drop constraint if exists app_users_profile_photo_data_check;

alter table public.app_users
  add constraint app_users_profile_photo_data_check
  check (
    profile_photo_data is null
    or (
      octet_length(profile_photo_data) <= 280000
      and profile_photo_data ~ '^data:image/(jpeg|png|webp);base64,'
    )
  );
